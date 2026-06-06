// Remote llama.cpp node (another machine on your network or Tailscale).
// Set BEAST_URL to the base URL of the llama.cpp server.
import type { AgentTask } from "../coordinator.js";

const BEAST_URL   = process.env.BEAST_URL   ?? "http://localhost:8081";
const BEAST_MODEL = process.env.BEAST_MODEL ?? "";

export async function execute(task: AgentTask): Promise<string> {
  const prompt = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : task.payload.prompt;

  const body: Record<string, unknown> = { prompt, n_predict: task.payload.max_tokens ?? 600, stop: ["\n\n\n"] };
  if (BEAST_MODEL) body.model = BEAST_MODEL;

  const res = await fetch(`${BEAST_URL}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) throw new Error(`Beast HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json() as { content?: string; error?: string };
  if (data.error) throw new Error(`Beast error: ${data.error}`);
  if (!data.content?.trim()) throw new Error("Beast returned empty response");
  return data.content.trim();
}
