import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;
type PublicMarket = Record<string, unknown> & {
  fetchedAt: string;
  servedAt: string;
  dataStatus: "fresh" | "cached" | "stale";
  warning?: string;
  usage: { providerRequests: number; cacheWindowMinutes: number };
};
type NewsItem = {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: string;
  sentimentScore: number | null;
  symbols: string[];
  timeBasis: "published" | "updated" | "filed";
};
type CacheEntry = { market: PublicMarket; freshUntil: number; staleUntil: number };

const CACHE_MS = 15 * 60 * 1_000;
const STALE_MS = 24 * 60 * 60 * 1_000;
const publicCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PublicMarket>>();

const SEC_CIK: Record<string, string> = {
  AAPL: "0000320193",
  MSFT: "0000789019",
  NVDA: "0001045810",
  AMZN: "0001018724",
  GOOGL: "0001652044",
  META: "0001326801",
  TSLA: "0001318605",
};

const MATERIAL_SEC_FORMS = new Set(["8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A", "DEF 14A", "DEFA14A", "SD", "S-3", "S-3ASR", "424B2", "424B5"]);

const COMPANY_FEEDS: Record<string, { url: string; source: string; format: "atom" | "rss"; timeBasis: "updated" | "published" }> = {
  AAPL: { url: "https://www.apple.com/newsroom/rss-feed.rss", source: "Apple Newsroom", format: "atom", timeBasis: "updated" },
  MSFT: { url: "https://news.microsoft.com/source/feed/", source: "Microsoft Source", format: "rss", timeBasis: "published" },
  NVDA: { url: "https://nvidianews.nvidia.com/releases.xml", source: "NVIDIA Newsroom", format: "rss", timeBasis: "published" },
};

const NASDAQ_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123 Safari/537.36 ClarityInvest/1.0",
};

function cleanSymbols(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim().toUpperCase())
    .filter((item) => /^[A-Z][A-Z.-]{0,9}$/.test(item))
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3);
}

function parseNumber(value: unknown) {
  const raw = String(value || "").replace(/[$,%\s,]/g, "");
  if (!raw || raw === "N/A" || raw === "--") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePercent(value: unknown) {
  const parsed = parseNumber(value);
  return parsed ? parsed / 100 : 0;
}

function labeledValue(record: unknown, key: string) {
  if (!record || typeof record !== "object") return "";
  const item = (record as Json)[key];
  if (item && typeof item === "object" && "value" in item) return String((item as Json).value || "");
  return "";
}

function tableValue(table: unknown, rowName: string, column = "value2") {
  if (!table || typeof table !== "object") return "";
  const rows = (table as Json).rows;
  if (!Array.isArray(rows)) return "";
  const row = rows.find((item) => item && typeof item === "object" && String((item as Json).value1) === rowName) as Json | undefined;
  return String(row?.[column] || "");
}

function decodeEntities(value: unknown) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchJson(url: string, headers?: Record<string, string>, timeout = 18_000) {
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`Public data source returned HTTP ${response.status}.`);
  const text = await response.text();
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error("The public data source returned an unreadable response.");
  }
}

async function fetchText(url: string, timeout = 18_000) {
  const response = await fetch(url, {
    headers: { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml", "User-Agent": "ClarityInvest educational prototype" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Official company feed returned HTTP ${response.status}.`);
  return response.text();
}

async function nasdaq(path: string) {
  const base = (process.env.PUBLIC_QUOTES_BASE_URL || "https://api.nasdaq.com/api").replace(/\/$/, "");
  const payload = await fetchJson(`${base}/${path}`, NASDAQ_HEADERS);
  const status = payload.status as Json | undefined;
  if (Number(status?.rCode || 0) !== 200 || !payload.data) throw new Error("Nasdaq did not return usable data for this ticker.");
  return payload.data as Json;
}

function xmlText(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function xmlAttribute(block: string, tag: string, attribute: string) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, "i"));
  return decodeEntities(match?.[1] || "");
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && value.length <= 2_048 ? url.toString() : "";
  } catch {
    return "";
  }
}

function parseCompanyFeed(symbol: string, xml: string, feed: (typeof COMPANY_FEEDS)[string]): NewsItem[] {
  const blockTag = feed.format === "atom" ? "entry" : "item";
  const blocks = xml.match(new RegExp(`<${blockTag}\\b[\\s\\S]*?<\\/${blockTag}>`, "gi")) || [];
  return blocks.slice(0, 6).flatMap((block) => {
    const title = xmlText(block, "title").slice(0, 300);
    const rawUrl = feed.format === "atom" ? xmlAttribute(block, "link", "href") : xmlText(block, "link");
    const url = safeHttpUrl(rawUrl);
    const rawTime = feed.format === "atom" ? xmlText(block, "updated") : xmlText(block, "pubDate");
    const timestamp = Date.parse(rawTime);
    if (!title || !url || !Number.isFinite(timestamp)) return [];
    return [{
      title,
      summary: `Official ${feed.source} item. Open the original source for full context.`,
      source: feed.source,
      url,
      publishedAt: new Date(timestamp).toISOString(),
      sentiment: "Not scored",
      sentimentScore: null,
      symbols: [symbol],
      timeBasis: feed.timeBasis,
    }];
  });
}

async function companyNews(symbol: string) {
  const feed = COMPANY_FEEDS[symbol];
  if (!feed) return [];
  return parseCompanyFeed(symbol, await fetchText(feed.url), feed);
}

async function secFilings(symbol: string) {
  const cik = SEC_CIK[symbol];
  const userAgent = process.env.SEC_USER_AGENT?.trim();
  if (!cik || !userAgent) return [];
  const payload = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    Accept: "application/json",
    "User-Agent": userAgent,
  });
  const filings = payload.filings as Json | undefined;
  const recent = filings?.recent as Json | undefined;
  const forms = Array.isArray(recent?.form) ? recent.form : [];
  const dates = Array.isArray(recent?.filingDate) ? recent.filingDate : [];
  const acceptanceTimes = Array.isArray(recent?.acceptanceDateTime) ? recent.acceptanceDateTime : [];
  const documents = Array.isArray(recent?.primaryDocument) ? recent.primaryDocument : [];
  const accessions = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];
  const items = Array.isArray(recent?.items) ? recent.items : [];
  const company = String(payload.name || symbol);
  const results: NewsItem[] = [];
  for (let index = 0; index < forms.length && results.length < 2; index += 1) {
    const form = String(forms[index] || "");
    const filingDate = String(dates[index] || "");
    const document = String(documents[index] || "");
    const accession = String(accessions[index] || "");
    if (!MATERIAL_SEC_FORMS.has(form) || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate) || !document || !accession) continue;
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${document}`;
    const itemNumbers = String(items[index] || "");
    const acceptedAt = String(acceptanceTimes[index] || "");
    const publishedAt = Number.isFinite(Date.parse(acceptedAt)) ? new Date(acceptedAt).toISOString() : new Date(`${filingDate}T00:00:00Z`).toISOString();
    results.push({
      title: `${company} filed Form ${form} with the SEC`,
      summary: itemNumbers ? `Official filing dated ${filingDate}; reported item numbers: ${itemNumbers}. Open SEC EDGAR for the complete filing.` : `Official filing dated ${filingDate}. Open SEC EDGAR for the complete filing.`,
      source: "SEC EDGAR",
      url,
      publishedAt,
      sentiment: "Not scored",
      sentimentScore: null,
      symbols: [symbol],
      timeBasis: "filed",
    });
  }
  return results;
}

function fulfilledData(result: PromiseSettledResult<Json>) {
  return result.status === "fulfilled" ? result.value : {};
}

function historyDate(value: unknown) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : "";
}

async function fetchPublicMarket(symbols: string[]): Promise<PublicMarket> {
  const fetchedAt = new Date().toISOString();
  const warnings: string[] = [];
  const primary = symbols[0];
  const fromDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);

  const historyPromise = Promise.all(symbols.map((symbol) => nasdaq(`quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${fromDate}&limit=2`)));
  const overviewPromise = Promise.allSettled([
    nasdaq(`quote/${encodeURIComponent(primary)}/summary?assetclass=stocks`),
    nasdaq(`company/${encodeURIComponent(primary)}/company-profile`),
    nasdaq(`company/${encodeURIComponent(primary)}/financials`),
    nasdaq(`quote/${encodeURIComponent(primary)}/eps?assetclass=stocks`),
  ]);
  const companyNewsPromise = Promise.allSettled(symbols.map((symbol) => companyNews(symbol)));
  const secPromise = Promise.allSettled(symbols.map((symbol) => secFilings(symbol)));

  const [historyResults, overviewResults, companyNewsResults, secResults] = await Promise.all([historyPromise, overviewPromise, companyNewsPromise, secPromise]);
  const quotes = historyResults.map((history, index) => {
    const tradesTable = history.tradesTable as Json | undefined;
    const rows = Array.isArray(tradesTable?.rows) ? tradesTable.rows : [];
    const latest = rows[0] as Json | undefined;
    const previous = rows[1] as Json | undefined;
    const price = parseNumber(latest?.close);
    const previousPrice = parseNumber(previous?.close);
    const change = price && previousPrice ? price - previousPrice : 0;
    const latestTradingDay = historyDate(latest?.date);
    if (!price || !previousPrice || !latestTradingDay) throw new Error(`The public quote source returned no usable end-of-day history for ${symbols[index]}.`);
    return {
      symbol: String(history.symbol || symbols[index]),
      price,
      change: Number(change.toFixed(4)),
      changePercent: `${change >= 0 ? "+" : ""}${((change / previousPrice) * 100).toFixed(2)}%`,
      latestTradingDay,
      volume: parseNumber(latest?.volume),
      isRealtime: false,
    };
  });
  if (quotes.length !== symbols.length) throw new Error("The public quote source did not return every requested ticker.");

  const summary = fulfilledData(overviewResults[0]).summaryData as Json | undefined;
  const profile = fulfilledData(overviewResults[1]);
  const financials = fulfilledData(overviewResults[2]);
  const epsData = fulfilledData(overviewResults[3]);
  if (overviewResults.some((result) => result.status === "rejected")) {
    warnings.push("Some company-detail fields were unavailable; price and news updates are still current to their displayed timestamps.");
  }
  const companyItems = companyNewsResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (companyNewsResults.some((result) => result.status === "rejected")) {
    warnings.push("Some official company news feeds could not be refreshed.");
  }
  const secItems = secResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (secResults.some((result) => result.status === "rejected")) {
    warnings.push("Some SEC filing feeds could not be refreshed.");
  }
  if (!companyItems.length && !secItems.length) warnings.push("No official company news or SEC filing events could be refreshed.");

  const income = financials.incomeStatementTable;
  const balance = financials.balanceSheetTable;
  const ratios = financials.financialRatiosTable;
  const revenue = parseNumber(tableValue(income, "Total Revenue"));
  const previousRevenue = parseNumber(tableValue(income, "Total Revenue", "value3"));
  const netIncome = parseNumber(tableValue(income, "Net Income"));
  const previousNetIncome = parseNumber(tableValue(income, "Net Income", "value3"));
  const totalAssets = parseNumber(tableValue(balance, "Total Assets"));
  const epsRows = Array.isArray(epsData.earningsPerShare) ? epsData.earningsPerShare : [];
  const trailingEps = epsRows
    .filter((item) => item && typeof item === "object" && (item as Json).type === "PreviousQuarter")
    .slice(-4)
    .reduce((sum, item) => sum + parseNumber((item as Json).earnings), 0);
  const marketCap = parseNumber(labeledValue(summary, "MarketCap"));
  const targetPrice = parseNumber(labeledValue(summary, "OneYrTarget"));
  const highLow = labeledValue(summary, "FiftTwoWeekHighLow").split("/").map(parseNumber);
  const companyName = labeledValue(profile, "CompanyName") || primary;
  const news = [...companyItems, ...secItems]
    .filter((item, index, list) => list.findIndex((candidate) => candidate.url === item.url) === index)
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, 12);
  const companyTimeBases = new Set(companyItems.map((item) => item.timeBasis));
  const newsTimeBasis = companyItems.length && secItems.length ? "mixed" : companyItems.length ? companyTimeBases.size === 1 ? companyItems[0].timeBasis : "mixed" : "filed";
  const newsSource = companyItems.length && secItems.length ? "Official company newsrooms + SEC EDGAR" : companyItems.length ? "Official company newsrooms" : "SEC EDGAR filings";
  const provider = secItems.length ? "Nasdaq + company newsrooms + SEC EDGAR" : "Nasdaq + company newsrooms";
  const secRequestCount = process.env.SEC_USER_AGENT?.trim() ? symbols.filter((symbol) => Boolean(SEC_CIK[symbol])).length : 0;
  const companyFeedRequestCount = symbols.filter((symbol) => Boolean(COMPANY_FEEDS[symbol])).length;

  return {
    fetchedAt,
    servedAt: new Date().toISOString(),
    dataStatus: "fresh",
    warning: warnings.length ? warnings.join(" ") : undefined,
    usage: { providerRequests: symbols.length + 4 + secRequestCount + companyFeedRequestCount, cacheWindowMinutes: CACHE_MS / 60_000 },
    freshness: { quotesFetchedAt: fetchedAt, overviewFetchedAt: fetchedAt, newsFetchedAt: fetchedAt },
    newsTimeBasis,
    dataMode: "public",
    sources: { quotes: "Nasdaq end-of-day history", fundamentals: "Nasdaq company data + app-derived ratios", news: newsSource },
    capabilities: { quotes: true, fundamentals: Boolean(Object.keys(profile).length || Object.keys(financials).length), news: news.length > 0, sentiment: false },
    symbols,
    quotes,
    overview: {
      symbol: primary,
      name: companyName,
      description: labeledValue(profile, "CompanyDescription"),
      sector: labeledValue(profile, "Sector") || labeledValue(summary, "Sector") || "—",
      industry: labeledValue(profile, "Industry") || labeledValue(summary, "Industry") || "—",
      marketCapitalization: marketCap,
      peRatio: trailingEps && quotes[0]?.price ? quotes[0].price / trailingEps : 0,
      pegRatio: 0,
      eps: trailingEps,
      profitMargin: parsePercent(tableValue(ratios, "Profit Margin")),
      returnOnAssets: netIncome && totalAssets ? netIncome / totalAssets : 0,
      returnOnEquity: parsePercent(tableValue(ratios, "After Tax ROE")),
      revenueGrowth: previousRevenue ? (revenue - previousRevenue) / previousRevenue : 0,
      earningsGrowth: previousNetIncome ? (netIncome - previousNetIncome) / previousNetIncome : 0,
      analystTargetPrice: targetPrice,
      fiftyTwoWeekHigh: highLow[0] || 0,
      fiftyTwoWeekLow: highLow[1] || 0,
    },
    news,
    provider,
  };
}

async function marketFor(symbols: string[]) {
  const cacheKey = symbols.join(",");
  const now = Date.now();
  const cached = publicCache.get(cacheKey);
  if (cached && cached.freshUntil > now) {
    return {
      ...cached.market,
      servedAt: new Date().toISOString(),
      dataStatus: "cached" as const,
      usage: { ...cached.market.usage, providerRequests: 0 },
    };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) {
    try {
      const market = await pending;
      return { ...market, servedAt: new Date().toISOString(), dataStatus: "cached" as const, usage: { ...market.usage, providerRequests: 0 } };
    } catch (error) {
      if (cached && cached.staleUntil > Date.now()) {
        const message = error instanceof Error ? error.message : "The public data sources could not be refreshed.";
        return { ...cached.market, servedAt: new Date().toISOString(), dataStatus: "stale" as const, warning: `${message} Showing the last successful snapshot instead.`, usage: { ...cached.market.usage, providerRequests: 0 } };
      }
      throw error;
    }
  }

  const providerRequest = fetchPublicMarket(symbols);
  inFlight.set(cacheKey, providerRequest);
  try {
    const market = await providerRequest;
    publicCache.set(cacheKey, { market, freshUntil: Date.now() + CACHE_MS, staleUntil: Date.now() + STALE_MS });
    while (publicCache.size > 32) {
      const oldestKey = publicCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      publicCache.delete(oldestKey);
    }
    return market;
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) {
      const message = error instanceof Error ? error.message : "The public data sources could not be refreshed.";
      return {
        ...cached.market,
        servedAt: new Date().toISOString(),
        dataStatus: "stale" as const,
        warning: `${message} Showing the last successful snapshot instead.`,
        usage: { ...cached.market.usage, providerRequests: 0 },
      };
    }
    throw error;
  } finally {
    if (inFlight.get(cacheKey) === providerRequest) inFlight.delete(cacheKey);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { symbols?: string[] };
    const symbols = cleanSymbols(body.symbols);
    if (!symbols.length) return NextResponse.json({ error: "Add at least one valid US ticker." }, { status: 400 });
    return NextResponse.json(await marketFor(symbols));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Public market data could not be updated.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
