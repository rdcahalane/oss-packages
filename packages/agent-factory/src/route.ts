import type { AgentTask } from "./coordinator.js";

// Tasks that can run on a cheap local model — auto-route to a remote or local lightweight model
const LOCAL_TYPES = new Set([
  "commit_msg", "docstring", "boilerplate", "code_review_single",
  "refactor_simple", "explain_fn", "seed_data",
  "summarize", "summarize_file", "summarize_diff",
]);

const GEMINI_TYPES = new Set([
  "long_doc", "pdf_analysis", "vision", "long_context", "spreadsheet",
]);

type AgentKey = "beast" | "local" | "claude" | "gemini" | "codex";

// Health check caches (60s TTL)
const cache: Record<string, { up: boolean; ts: number }> = {};

async function isUp(url: string): Promise<boolean> {
  const hit = cache[url];
  if (hit && Date.now() - hit.ts < 60_000) return hit.up;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    cache[url] = { up: r.ok, ts: Date.now() };
  } catch {
    cache[url] = { up: false, ts: Date.now() };
  }
  return cache[url].up;
}

async function bestLocalAgent(): Promise<AgentKey | null> {
  const beastHealth = process.env.BEAST_HEALTH_URL ?? (process.env.BEAST_URL ? `${process.env.BEAST_URL}/health` : "");
  if (beastHealth && await isUp(beastHealth)) return "beast";
  if (process.env.OLLAMA_URL && await isUp(`${process.env.OLLAMA_URL}/api/tags`)) return "local";
  return null;
}

export async function routeTask(task: AgentTask): Promise<AgentKey> {
  if (task.to_agent !== "auto") return task.to_agent as AgentKey;

  if (LOCAL_TYPES.has(task.type)) {
    const local = await bestLocalAgent();
    if (local) return local;
    // fall through to claude if no local available
  }

  if (GEMINI_TYPES.has(task.type)) return "gemini"; // uses gemini-cli (subscription auth, no API key)

  return "claude";
}
