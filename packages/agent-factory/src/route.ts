import type { AgentTask } from "./coordinator.js";

// Tasks that can run on a cheap local model — auto-route to beast or local
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
  const beastBase = process.env.BEAST_URL ?? "http://localhost:8081";
  const beastHealth = process.env.BEAST_HEALTH_URL ?? `${beastBase.replace(/\/$/, "")}/health`;
  if (beastHealth && await isUp(beastHealth)) return "beast";
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  if (ollamaUrl && await isUp(`${ollamaUrl.replace(/\/$/, "")}/api/tags`)) return "local";
  return null;
}

/** Heuristic: does this text appear to be primarily non-English?
 *  >40% non-ASCII printable chars (CJK, Arabic, Cyrillic, etc.) → likely non-Latin script.
 *  Beast's multilingual capability is weak; Claude handles it better. */
function isNonEnglish(text: string): boolean {
  const printable = text.replace(/\s/g, "");
  if (printable.length < 4) return false;
  const nonLatin = printable.split("").filter(c => c.charCodeAt(0) > 0x024F).length;
  return nonLatin / printable.length > 0.4;
}

/** Return true if this chat task needs Claude — Beast can't handle it well. */
function needsClaude(task: AgentTask): boolean {
  if (task.type !== "chat") return false;
  const prompt = String(task.payload.prompt ?? "");
  // Use the original pre-enrichment prompt for length and complexity checks so that
  // injected history/profile context doesn't incorrectly push simple prompts to Claude.
  const originalPrompt = String(task.payload._original_prompt ?? task.payload.prompt ?? "");
  return (
    /https?:\/\//.test(originalPrompt) ||                                 // user message contains a URL
    /^Web context:/m.test(prompt) ||                                      // web context was injected (check full enriched)
    originalPrompt.length > 2500 ||                                       // long original = complex reasoning
    isNonEnglish(originalPrompt) ||                                       // non-Latin script → Claude
    // Verbs that signal depth/complexity Claude handles better than Beast.
    // Deliberately narrow: brainstorm verbs (write, recommend, improve, research, plan)
    // are intentionally excluded — Beast handles those fine.
    /\b(analyze|compare|review|implement|summarize all|evaluate|diagnose|explain.*why|what.*missing|what.*wrong|deploy|migrate|refactor|architect|debug|troubleshoot)\b/i.test(originalPrompt)
  );
}

export async function routeTask(task: AgentTask): Promise<AgentKey> {
  if (task.to_agent !== "auto") return task.to_agent as AgentKey;

  if (LOCAL_TYPES.has(task.type)) {
    const local = await bestLocalAgent();
    if (local) return local;
    // fall through to claude if no local available
  }

  if (GEMINI_TYPES.has(task.type)) return "gemini";

  // Complex chat → Claude. Beast handles simple conversational chat only.
  if (needsClaude(task)) return "claude";

  const local = await bestLocalAgent();
  if (local) return local;

  return "claude";
}
