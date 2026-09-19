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

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { alphaVantageKey?: string; symbols?: string[] };
    const apiKey = body.alphaVantageKey?.trim() || process.env.ALPHA_VANTAGE_API_KEY;
    const symbols = cleanSymbols(body.symbols);

    if (!apiKey) return NextResponse.json({ error: "Add an Alpha Vantage API key." }, { status: 400 });
    if (!symbols.length) return NextResponse.json({ error: "Add at least one valid US ticker." }, { status: 400 });

    // Three quotes + one overview + one combined news request stays within a typical free-tier burst.
    const [quotePayloads, overview, newsPayload] = await Promise.all([
      Promise.all(symbols.map((symbol) => alphaRequest({ function: "GLOBAL_QUOTE", symbol }, apiKey))),
      alphaRequest({ function: "OVERVIEW", symbol: symbols[0] }, apiKey),
      alphaRequest({ function: "NEWS_SENTIMENT", tickers: symbols.join(","), limit: "8", sort: "LATEST" }, apiKey),
    ]);

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

    const feed = Array.isArray(newsPayload.feed) ? newsPayload.feed : [];
    const news = feed.slice(0, 8).map((item) => {
      const row = item as Record<string, unknown>;
      return {
        title: String(row.title || "Untitled market update"),
        summary: String(row.summary || ""),
        source: String(row.source || "Alpha Vantage feed"),
        url: String(row.url || ""),
        publishedAt: String(row.time_published || ""),
        sentiment: String(row.overall_sentiment_label || "Neutral"),
        sentimentScore: Number(row.overall_sentiment_score || 0),
      };
    });

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
