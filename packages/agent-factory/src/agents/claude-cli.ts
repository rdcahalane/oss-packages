/**
 * Claude agent — calls Anthropic API directly (plain HTTP, no SDK dep).
 *
 * Previous implementation spawned `claude -p -` as a child process, which
 * fails with 401 because the subprocess doesn't inherit OAuth session creds.
 * This version uses ANTHROPIC_API_KEY from the environment directly.
 *
 * Falls back to Beast if ANTHROPIC_API_KEY is not set.
 */
import type { AgentTask } from "../coordinator.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL         = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5";
const BEAST_URL     = process.env.BEAST_URL    ?? "http://localhost:8081";

async function callAnthropic(prompt: string, maxTokens: number, rulesSection = ""): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-api-key":       ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: maxTokens,
      system: `You are AgentFactory, a helpful AI assistant built for ${process.env.BOT_OWNER_NAME ?? "your team"}. ` +
        "Key rules: (1) If asked to fix, debug, or review code or files that were NOT shared in the conversation, ask the user to share them first — do not guess or give generic steps as if you have seen the code. " +
        "(2) If a request contains contradictory requirements (e.g. 'fix this but don't change any code'), explicitly point out the contradiction before proceeding. " +
        "(3) Never claim to have executed, deployed, or run code — you can only provide text responses." +
        rulesSection,
      messages:   [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    content?: { type: string; text: string }[];
    error?:   { message: string };
  };

  if (data.error) throw new Error(`Anthropic error: ${data.error.message}`);

  return (data.content ?? [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("")
    .trim();
}

async function callBeastFallback(prompt: string, maxTokens: number): Promise<string> {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: true });
  const res = await fetch(`${BEAST_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: `You are a helpful, analytical assistant. Current time: ${now} ET.` },
        { role: "user",   content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Beast fallback ${res.status}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function execute(task: AgentTask): Promise<string> {
  const prompt    = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : String(task.payload.prompt ?? "");
  const maxTokens = Number(task.payload.max_tokens ?? 2000);
  const rulesSection = task.payload.user_rules
    ? `\n\nBehavior rules set by the user — follow these exactly:\n${task.payload.user_rules}`
    : "";

  if (!ANTHROPIC_KEY) {
    console.warn("[claude-agent] ANTHROPIC_API_KEY not set — falling back to Beast");
    return callBeastFallback(prompt, maxTokens);
  }

  return callAnthropic(prompt, maxTokens, rulesSection);
}
