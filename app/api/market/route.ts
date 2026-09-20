import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AlphaJson = Record<string, unknown>;
type CacheSource = "network" | "cache" | "stale";
type AlphaErrorKind = "rate_limit" | "auth" | "temporary" | "upstream";
type CacheEntry = { payload: AlphaJson; fetchedAt: string; freshUntil: number; staleUntil: number };
type CachedPayload = CacheEntry & { source: CacheSource };

const SHORT_CACHE_MS = 15 * 60 * 1_000;
const SHORT_STALE_MS = 24 * 60 * 60 * 1_000;
const OVERVIEW_CACHE_MS = 24 * 60 * 60 * 1_000;
const OVERVIEW_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 256;

const endpointCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();
const rateLimitedUntil = new Map<string, number>();
let alphaQueue: Promise<void> = Promise.resolve();
let lastAlphaRequestAt = 0;

class AlphaRequestError extends Error {
  constructor(message: string, readonly status: number, readonly kind: AlphaErrorKind) {
    super(message);
    this.name = "AlphaRequestError";
  }
}

function cleanSymbols(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim().toUpperCase())
    .filter((item) => /^[A-Z][A-Z.-]{0,9}$/.test(item))
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3);
}

function providerError(payload: AlphaJson) {
  return payload.Note || payload.Information || payload["Error Message"];
}

function keyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function endpointKey(apiKey: string, params: Record<string, string>) {
  const query = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${keyFingerprint(apiKey)}:${query}`;
}

function safeProviderMessage(message: unknown, apiKey: string) {
  return String(message || "").split(apiKey).join("[redacted]");
}

function classifyProviderMessage(message: string) {
  if (/25 requests per day|rate limit|call frequency|higher api call frequency/i.test(message)) return "rate_limit" as const;
  if (/invalid api key|api key is invalid|authentication|unauthorized/i.test(message)) return "auth" as const;
  return "upstream" as const;
}

function controlledProviderError(kind: AlphaErrorKind) {
  if (kind === "rate_limit") return new AlphaRequestError("Alpha Vantage's free 25-request daily allowance has been reached. No saved snapshot was available, so current market data cannot be refreshed yet.", 429, kind);
  if (kind === "auth") return new AlphaRequestError("Alpha Vantage rejected this API key. Replace the exposed key with a new valid key and try again.", 401, kind);
  if (kind === "temporary") return new AlphaRequestError("Alpha Vantage could not be reached. A saved snapshot will be used when available.", 503, kind);
  return new AlphaRequestError("Alpha Vantage could not provide usable market data for this request.", 502, kind);
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queueAlphaRequest<T>(request: () => Promise<T>) {
  const run = alphaQueue.then(async () => {
    const delay = Math.max(0, 1_100 - (Date.now() - lastAlphaRequestAt));
    if (delay) await wait(delay);
    lastAlphaRequestAt = Date.now();
    return request();
  });
  alphaQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function alphaRequest(params: Record<string, string>, apiKey: string) {
  return queueAlphaRequest(async () => {
    const url = new URL(process.env.ALPHA_VANTAGE_BASE_URL || "https://www.alphavantage.co/query");
    Object.entries({ ...params, apikey: apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
    let response: Response;
    try {
      response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(18_000) });
    } catch {
      throw controlledProviderError("temporary");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw controlledProviderError("auth");
      if (response.status === 429) throw controlledProviderError("rate_limit");
      if (response.status >= 500) throw controlledProviderError("temporary");
      throw controlledProviderError("upstream");
    }
    let payload: AlphaJson;
    try {
      payload = (await response.json()) as AlphaJson;
    } catch {
      throw controlledProviderError("upstream");
    }
    const rawMessage = providerError(payload);
    if (rawMessage) {
      const safeMessage = safeProviderMessage(rawMessage, apiKey);
      throw controlledProviderError(classifyProviderMessage(safeMessage));
    }
    return payload;
  });
}

function saveCache(key: string, entry: CacheEntry) {
  endpointCache.delete(key);
  endpointCache.set(key, entry);
  if (endpointCache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [cacheKey, cached] of endpointCache) {
    if (cached.staleUntil <= now) endpointCache.delete(cacheKey);
  }
  while (endpointCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = endpointCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    endpointCache.delete(oldestKey);
  }
}

async function cachedAlphaRequest(
  params: Record<string, string>,
  apiKey: string,
  freshFor: number,
  staleFor: number,
  isValid: (payload: AlphaJson) => boolean,
): Promise<CachedPayload> {
  const now = Date.now();
  const fingerprint = keyFingerprint(apiKey);
  const cacheKey = endpointKey(apiKey, params);
  const cached = endpointCache.get(cacheKey);
  if (cached && cached.freshUntil > now) return { ...cached, source: "cache" };

  if ((rateLimitedUntil.get(fingerprint) || 0) > now) {
    if (cached && cached.staleUntil > now) return { ...cached, source: "stale" };
    throw controlledProviderError("rate_limit");
  }

  const pending = inFlight.get(cacheKey);
  if (pending) {
    try {
      const entry = await pending;
      return { ...entry, source: "cache" };
    } catch (error) {
      if (error instanceof AlphaRequestError && error.kind !== "auth" && cached && cached.staleUntil > Date.now()) {
        return { ...cached, source: "stale" };
      }
      throw error;
    }
  }

  const providerRequest = alphaRequest(params, apiKey).then((payload) => {
    if (!isValid(payload)) throw controlledProviderError("upstream");
    const fetchedAt = new Date().toISOString();
    const entry = { payload, fetchedAt, freshUntil: Date.now() + freshFor, staleUntil: Date.now() + staleFor };
    saveCache(cacheKey, entry);
    return entry;
  });
  inFlight.set(cacheKey, providerRequest);

  try {
    const entry = await providerRequest;
    return { ...entry, source: "network" };
  } catch (error) {
    if (error instanceof AlphaRequestError && error.kind === "rate_limit") {
      rateLimitedUntil.set(fingerprint, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    }
    if (error instanceof AlphaRequestError && error.kind !== "auth" && cached && cached.staleUntil > Date.now()) {
      return { ...cached, source: "stale" };
    }
    throw error;
  } finally {
    if (inFlight.get(cacheKey) === providerRequest) inFlight.delete(cacheKey);
  }
}

function alphaTime(date: Date) {
  return `${date.toISOString().slice(0, 10).replace(/-/g, "")}T0000`;
}

function normalizePublishedAt(value: unknown) {
  const raw = String(value || "");
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return raw;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))).toISOString();
}

function oldestFetchedAt(results: CachedPayload[]) {
  const times = results.map((result) => Date.parse(result.fetchedAt)).filter(Number.isFinite);
  return new Date(times.length ? Math.min(...times) : Date.now()).toISOString();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { alphaVantageKey?: string; symbols?: string[] };
    const apiKey = body.alphaVantageKey?.trim() || process.env.ALPHA_VANTAGE_API_KEY;
    const symbols = cleanSymbols(body.symbols);

    if (!apiKey) return NextResponse.json({ error: "Add an Alpha Vantage API key." }, { status: 400 });
    if (!symbols.length) return NextResponse.json({ error: "Add at least one valid US ticker." }, { status: 400 });

    const quotePayloads: CachedPayload[] = [];
    for (const symbol of symbols) {
      quotePayloads.push(await cachedAlphaRequest(
        { function: "GLOBAL_QUOTE", symbol },
        apiKey,
        SHORT_CACHE_MS,
        SHORT_STALE_MS,
        (payload) => Boolean(payload["Global Quote"] && typeof payload["Global Quote"] === "object"),
      ));
    }

    const overviewResult = await cachedAlphaRequest(
      { function: "OVERVIEW", symbol: symbols[0] },
      apiKey,
      OVERVIEW_CACHE_MS,
      OVERVIEW_STALE_MS,
      (payload) => typeof payload.Symbol === "string" && Boolean(payload.Symbol),
    );

    const newsPayloads: { symbol: string; result: CachedPayload }[] = [];
    const timeFrom = alphaTime(new Date(Date.now() - 14 * 24 * 60 * 60 * 1_000));
    for (const symbol of symbols) {
      const result = await cachedAlphaRequest(
        { function: "NEWS_SENTIMENT", tickers: symbol, time_from: timeFrom, limit: "20", sort: "LATEST" },
        apiKey,
        SHORT_CACHE_MS,
        SHORT_STALE_MS,
        (payload) => Array.isArray(payload.feed),
      );
      newsPayloads.push({ symbol, result });
    }

    const quotes = quotePayloads.map(({ payload }, index) => {
      const q = (payload["Global Quote"] || {}) as Record<string, string>;
      return {
        symbol: q["01. symbol"] || symbols[index],
        price: Number(q["05. price"] || 0),
        change: Number(q["09. change"] || 0),
        changePercent: q["10. change percent"] || "—",
        latestTradingDay: q["07. latest trading day"] || "—",
        volume: Number(q["06. volume"] || 0),
      };
    });

    const overview = overviewResult.payload;
    const collectedNews = newsPayloads.flatMap(({ symbol, result }) => {
      const feed = Array.isArray(result.payload.feed) ? result.payload.feed : [];
      return feed.map((item) => {
        const row = item as Record<string, unknown>;
        const tickerSentiment = Array.isArray(row.ticker_sentiment) ? row.ticker_sentiment : [];
        const relatedSymbols = tickerSentiment
          .map((entry) => String((entry as Record<string, unknown>).ticker || ""))
          .filter(Boolean);
        return {
          title: String(row.title || "Untitled market update"),
          summary: String(row.summary || ""),
          source: String(row.source || "Alpha Vantage feed"),
          url: String(row.url || ""),
          publishedAt: normalizePublishedAt(row.time_published),
          sentiment: String(row.overall_sentiment_label || "Neutral"),
          sentimentScore: Number(row.overall_sentiment_score || 0),
          symbols: relatedSymbols.length ? relatedSymbols : [symbol],
        };
      });
    });
    const uniqueNews = new Map<string, (typeof collectedNews)[number]>();
    for (const item of collectedNews) {
      const key = item.url || `${item.title}-${item.publishedAt}`;
      if (!uniqueNews.has(key)) uniqueNews.set(key, item);
    }
    const news = Array.from(uniqueNews.values())
      .filter((item) => Number.isFinite(Date.parse(item.publishedAt)))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, 12);

    const allResults = [...quotePayloads, overviewResult, ...newsPayloads.map(({ result }) => result)];
    const timeSensitiveResults = [...quotePayloads, ...newsPayloads.map(({ result }) => result)];
    const dataStatus = allResults.some((result) => result.source === "stale")
      ? "stale"
      : allResults.some((result) => result.source === "network")
        ? "fresh"
        : "cached";
    const alphaRequests = allResults.filter((result) => result.source === "network").length;
    const fetchedAt = oldestFetchedAt(timeSensitiveResults);
    const warning = dataStatus === "stale"
      ? "Alpha Vantage could not refresh the feed, so this response uses the last successful snapshot. Check the source timestamps before relying on it."
      : undefined;

    return NextResponse.json({
      fetchedAt,
      servedAt: new Date().toISOString(),
      dataStatus,
      warning,
      usage: { providerRequests: alphaRequests, alphaRequests, cacheWindowMinutes: SHORT_CACHE_MS / 60_000 },
      freshness: {
        quotesFetchedAt: oldestFetchedAt(quotePayloads),
        overviewFetchedAt: overviewResult.fetchedAt,
        newsFetchedAt: oldestFetchedAt(newsPayloads.map(({ result }) => result)),
      },
      symbols,
      newsTimeBasis: "published",
      dataMode: "alpha",
      sources: { quotes: "Alpha Vantage", fundamentals: "Alpha Vantage", news: "Alpha Vantage" },
      capabilities: { quotes: true, fundamentals: true, news: true, sentiment: true },
      quotes,
      overview: {
        symbol: String(overview.Symbol || symbols[0]),
        name: String(overview.Name || symbols[0]),
        description: String(overview.Description || ""),
        sector: String(overview.Sector || "—"),
        industry: String(overview.Industry || "—"),
        marketCapitalization: Number(overview.MarketCapitalization || 0),
        peRatio: Number(overview.PERatio || 0),
        pegRatio: Number(overview.PEGRatio || 0),
        eps: Number(overview.EPS || 0),
        profitMargin: Number(overview.ProfitMargin || 0),
        returnOnAssets: Number(overview.ReturnOnAssetsTTM || 0),
        returnOnEquity: Number(overview.ReturnOnEquityTTM || 0),
        revenueGrowth: Number(overview.QuarterlyRevenueGrowthYOY || 0),
        earningsGrowth: Number(overview.QuarterlyEarningsGrowthYOY || 0),
        analystTargetPrice: Number(overview.AnalystTargetPrice || 0),
        fiftyTwoWeekHigh: Number(overview["52WeekHigh"] || 0),
        fiftyTwoWeekLow: Number(overview["52WeekLow"] || 0),
      },
      news,
      provider: "Alpha Vantage",
    });
  } catch (error) {
    if (error instanceof AlphaRequestError) {
      return NextResponse.json({ error: error.message, code: error.kind }, { status: error.status });
    }
    return NextResponse.json({ error: "Market data request failed without exposing your API key." }, { status: 502 });
  }
}
