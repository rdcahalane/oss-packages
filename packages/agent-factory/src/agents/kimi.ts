// Kimi K2.5 via OpenRouter — PAID (moonshotai/kimi-k2.5). Frontier-class debater
// for genuine model diversity. Requires OPENROUTER_API_KEY (in .env).
import type { AgentTask } from "../coordinator.js";

const URL   = "https://openrouter.ai/api/v1/chat/completions";
// Default to non-thinking k2 — returns debate content directly. Reasoning variants
// (k2.5) can spend the whole token budget on hidden reasoning and return empty
// content. Override with KIMI_MODEL for a thinking model.
const MODEL = process.env.KIMI_MODEL ?? "moonshotai/kimi-k2";

export async function execute(task: AgentTask): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("kimi: OPENROUTER_API_KEY not set");
  const prompt = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : task.payload.prompt;
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: task.payload.max_tokens ?? 700,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`kimi OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string; reasoning?: string } }> };
  const msg = data?.choices?.[0]?.message;
  const content = (msg?.content || msg?.reasoning)?.trim();
  if (!content) throw new Error("kimi returned empty response");
  return content;
}
