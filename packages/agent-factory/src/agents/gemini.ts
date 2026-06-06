import type { AgentTask } from "../coordinator.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";

export async function execute(task: AgentTask): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini not configured — set GEMINI_API_KEY in .env");

  const prompt = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : task.payload.prompt;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };
  if (task.payload.system) {
    body.systemInstruction = { parts: [{ text: task.payload.system }] };
  }
  if (task.payload.max_tokens) {
    body.generationConfig = { maxOutputTokens: task.payload.max_tokens };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message: string };
  };
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}
