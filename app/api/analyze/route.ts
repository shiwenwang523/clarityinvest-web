import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "confidence", "decision", "agents", "bullCase", "bearCase", "riskFlags", "learningNotes"],
  properties: {
    summary: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["label", "rationale", "reviewTrigger"],
      properties: {
        label: { type: "string" },
        rationale: { type: "string" },
        reviewTrigger: { type: "string" },
      },
    },
    agents: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "score", "verdict", "findings"],
        properties: {
          name: { type: "string", enum: ["Market Analyst", "Fundamentals Analyst", "News Analyst", "Sentiment Analyst"] },
          score: { type: "number", minimum: 0, maximum: 100 },
          verdict: { type: "string" },
          findings: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
        },
      },
    },
    bullCase: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
    bearCase: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
    riskFlags: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" } },
    learningNotes: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
  },
} as const;

function extractText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as Array<Record<string, unknown>>)
      : [];
    for (const part of content) if (typeof part.text === "string") return part.text;
  }
  return "";
}

async function openAIRequest(apiKey: string, payload: Record<string, unknown>) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = data.error as Record<string, unknown> | undefined;
    throw new Error(String(apiError?.message || `OpenAI returned HTTP ${response.status}.`));
  }
  return data;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      openAIKey?: string;
      model?: string;
      mode?: "analyze" | "chat";
      market?: unknown;
      profile?: unknown;
      holdings?: unknown;
      question?: string;
      priorAnalysis?: unknown;
    };
    const apiKey = body.openAIKey?.trim() || process.env.OPENAI_API_KEY;
    const model = String(body.model || "gpt-4.1-mini").slice(0, 64);
    if (!apiKey) return NextResponse.json({ error: "Add an OpenAI API key." }, { status: 400 });

    const context = JSON.stringify({ market: body.market, profile: body.profile, holdings: body.holdings }).slice(0, 28_000);
    const system = `You are ClarityInvest, an explainable multi-agent investment education assistant. Use only the supplied data. Distinguish facts, inferences, and missing information. Give concrete portfolio suggestions when supported, but state uncertainty and never promise returns. Treat a user-requested holding change as a constraint change that requires a fresh risk explanation. Do not invent citations, prices, ratios, analyst ratings, or events.`;

    if (body.mode === "chat") {
      const chatContext = JSON.stringify(body.priorAnalysis || {}).slice(0, 12_000);
      const data = await openAIRequest(apiKey, {
        model,
        input: [
          { role: "system", content: system },
          { role: "user", content: `Portfolio context:\n${context}\n\nPrior multi-agent analysis:\n${chatContext}\n\nQuestion: ${String(body.question || "Explain this portfolio.").slice(0, 2_000)}\n\nAnswer in concise plain English. Explain technical terms and identify whether the question merely asks for education or changes the portfolio.` },
        ],
        max_output_tokens: 700,
      });
      const answer = extractText(data);
      if (!answer) throw new Error("OpenAI returned no readable answer.");
      return NextResponse.json({ answer });
    }

    const data = await openAIRequest(apiKey, {
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: `Run the TradingAgents-inspired workflow: Market, Fundamentals, News, and Sentiment analysts; Bull/Bear research debate; trader proposal; risk gate; final portfolio-manager decision. Analyze this exact context:\n${context}` },
      ],
      text: { format: { type: "json_schema", name: "clarityinvest_analysis", strict: true, schema: ANALYSIS_SCHEMA } },
      max_output_tokens: 2_200,
    });
    const text = extractText(data);
    if (!text) throw new Error("OpenAI returned no structured analysis.");
    return NextResponse.json({ analysis: JSON.parse(text), model, generatedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI analysis failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
