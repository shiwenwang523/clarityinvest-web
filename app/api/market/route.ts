import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AlphaJson = Record<string, unknown>;

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

async function alphaRequest(params: Record<string, string>, apiKey: string) {
  const url = new URL("https://www.alphavantage.co/query");
  Object.entries({ ...params, apikey: apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(18_000) });
  if (!response.ok) throw new Error(`Alpha Vantage returned HTTP ${response.status}.`);
  const payload = (await response.json()) as AlphaJson;
  const message = providerError(payload);
  if (message) throw new Error(String(message));
  return payload;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function alphaTime(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").slice(0, 13);
}

function normalizePublishedAt(value: unknown) {
  const raw = String(value || "");
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return raw;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))).toISOString();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { alphaVantageKey?: string; symbols?: string[] };
    const apiKey = body.alphaVantageKey?.trim() || process.env.ALPHA_VANTAGE_API_KEY;
    const symbols = cleanSymbols(body.symbols);

    if (!apiKey) return NextResponse.json({ error: "Add an Alpha Vantage API key." }, { status: 400 });
    if (!symbols.length) return NextResponse.json({ error: "Add at least one valid US ticker." }, { status: 400 });

    // The free Alpha Vantage tier asks clients to stay at or below one request
    // per second. Run every provider call sequentially with a small buffer.
    const quotePayloads: AlphaJson[] = [];
    for (const symbol of symbols) {
      if (quotePayloads.length) await wait(1_100);
      quotePayloads.push(await alphaRequest({ function: "GLOBAL_QUOTE", symbol }, apiKey));
    }
    await wait(1_100);
    const overview = await alphaRequest({ function: "OVERVIEW", symbol: symbols[0] }, apiKey);

    // Alpha Vantage treats a comma-separated ticker query as an AND filter.
    // Query each holding separately so a fresh AAPL-only article is not hidden
    // just because it does not also mention MSFT and NVDA.
    const newsPayloads: { symbol: string; payload: AlphaJson }[] = [];
    const timeFrom = alphaTime(new Date(Date.now() - 14 * 24 * 60 * 60 * 1_000));
    for (const symbol of symbols) {
      await wait(1_100);
      const payload = await alphaRequest({ function: "NEWS_SENTIMENT", tickers: symbol, time_from: timeFrom, limit: "20", sort: "LATEST" }, apiKey);
      newsPayloads.push({ symbol, payload });
    }

    const quotes = quotePayloads.map((payload, index) => {
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

    const collectedNews = newsPayloads.flatMap(({ symbol, payload }) => {
      const feed = Array.isArray(payload.feed) ? payload.feed : [];
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

    return NextResponse.json({
      fetchedAt: new Date().toISOString(),
      symbols,
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
    const message = error instanceof Error ? error.message : "Market data request failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
