// Canoeputer agent — second local inference node (Ollama, RTX 2070 + 80GB RAM).
// Distinct model from Beast so debates get genuine model diversity for free ($0).
import type { AgentTask } from "../coordinator.js";

const CANOE_URL   = process.env.CANOE_OLLAMA_URL ?? "http://localhost:11434";
const CANOE_MODEL = process.env.CANOE_MODEL      ?? "qwen2.5-coder:7b";

export async function execute(task: AgentTask): Promise<string> {
  const prompt = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : task.payload.prompt;

  const res = await fetch(`${CANOE_URL.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CANOE_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) throw new Error(`canoe Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { response?: string; error?: string };
  if (data.error) throw new Error(`canoe Ollama error: ${data.error}`);
  if (!data.response?.trim()) throw new Error("canoe Ollama returned empty response");
  return data.response.trim();
}
