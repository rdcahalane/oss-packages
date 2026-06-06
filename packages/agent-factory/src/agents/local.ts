// Ollama-compatible local model agent.
// Install Ollama: https://ollama.ai  →  `ollama pull llama3.2`
// Or point OLLAMA_URL at any llama.cpp server (OpenAI-compatible /v1/completions).
import type { AgentTask } from "../coordinator.js";

const OLLAMA_URL   = process.env.OLLAMA_URL   ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

export async function execute(task: AgentTask): Promise<string> {
  if (!process.env.OLLAMA_URL && !process.env.OLLAMA_MODEL) {
    throw new Error("Local model not configured — set OLLAMA_URL and OLLAMA_MODEL in .env");
  }

  const prompt = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : task.payload.prompt;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json() as { response?: string; error?: string };
  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  if (!data.response?.trim()) throw new Error("Ollama returned empty response");
  return data.response.trim();
}
