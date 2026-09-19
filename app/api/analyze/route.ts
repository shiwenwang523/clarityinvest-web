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
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => {
        const item = part as Record<string, unknown>;
        return typeof item.text === "string" ? item.text : "";
      })
      .join("");
  }
  return "";
}

function parseJsonObject(text: string) {
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const withoutFence = withoutThinking.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("GLM returned no readable JSON object.");
  return JSON.parse(withoutFence.slice(start, end + 1));
}

async function glmRequest(apiKey: string, payload: Record<string, unknown>) {
  const baseUrl = (process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = data.error as Record<string, unknown> | undefined;
    throw new Error(String(apiError?.message || data.message || data.msg || `GLM returned HTTP ${response.status}.`));
  }
  return data;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      glmKey?: string;
      model?: string;
      mode?: "analyze" | "chat";
      market?: unknown;
      profile?: unknown;
      holdings?: unknown;
      question?: string;
      priorAnalysis?: unknown;
    };
    const apiKey = body.glmKey?.trim() || process.env.GLM_API_KEY;
    const model = String(body.model || process.env.GLM_MODEL || "glm-5.2").slice(0, 64);
    if (!apiKey) return NextResponse.json({ error: "Add a GLM API key." }, { status: 400 });

    const context = JSON.stringify({ market: body.market, profile: body.profile, holdings: body.holdings }).slice(0, 28_000);
    const system = "You are ClarityInvest, an explainable multi-agent investment education assistant. Use only the supplied data. Distinguish facts, inferences, and missing information. Give concrete portfolio suggestions when supported, but state uncertainty and never promise returns. Treat a user-requested holding change as a constraint change that requires a fresh risk explanation. Do not invent citations, prices, ratios, analyst ratings, or events.";

    if (body.mode === "chat") {
      const chatContext = JSON.stringify(body.priorAnalysis || {}).slice(0, 12_000);
      const data = await glmRequest(apiKey, {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Portfolio context:\n${context}\n\nPrior multi-agent analysis:\n${chatContext}\n\nQuestion: ${String(body.question || "Explain this portfolio.").slice(0, 2_000)}\n\nAnswer in concise plain English. Explain technical terms and identify whether the question merely asks for education or changes the portfolio.` },
        ],
        thinking: { type: "enabled" },
        max_tokens: 900,
        temperature: 0.3,
        stream: false,
      });
      const answer = extractText(data);
      if (!answer) throw new Error("GLM returned no readable answer.");
      return NextResponse.json({ answer });
    }

    const data = await glmRequest(apiKey, {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Run the TradingAgents-inspired workflow: Market, Fundamentals, News, and Sentiment analysts; Bull/Bear research debate; trader proposal; risk gate; final portfolio-manager decision. Analyze this exact context:\n${context}\n\nReturn only one valid JSON object that follows this JSON Schema exactly. Do not use markdown fences or add commentary:\n${JSON.stringify(ANALYSIS_SCHEMA)}` },
      ],
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      max_tokens: 3_000,
      temperature: 0.2,
      stream: false,
    });
    const text = extractText(data);
    if (!text) throw new Error("GLM returned no structured analysis.");
    return NextResponse.json({ analysis: parseJsonObject(text), model, generatedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI analysis failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
