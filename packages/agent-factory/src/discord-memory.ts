import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import pool from "./db.js";

// ---------------------------------------------------------------------------
// Owner profile — loaded once at startup from PROFILE_FILE env var.
// Set this to any markdown file describing the bot owner (e.g. ~/brain/USER.md).
// Injected into every enriched prompt so the model knows who it's talking to
// and can answer personal questions without relying on semantic search.
// Capped at 2000 chars to keep prompts manageable.
// ---------------------------------------------------------------------------
let _profileCache: string | null = null;

export async function getOwnerProfile(): Promise<string> {
  if (_profileCache !== null) return _profileCache;
  const profileFile = process.env.PROFILE_FILE;
  if (!profileFile) { _profileCache = ""; return ""; }
  try {
    const expanded = profileFile.replace(/^~/, os.homedir());
    const content = await readFile(expanded, "utf8");
    // Strip YAML frontmatter if present
    const stripped = content.replace(/^---[\s\S]*?---\n?/, "").trim();
    _profileCache = stripped.slice(0, 2000);
    console.log(`[discord-memory] Loaded owner profile from ${profileFile} (${_profileCache.length} chars)`);
    return _profileCache;
  } catch (err: any) {
    console.warn(`[discord-memory] Could not load PROFILE_FILE ${profileFile}: ${err?.message}`);
    _profileCache = "";
    return "";
  }
}

// ---------------------------------------------------------------------------
// OpenBrain integration — read relevant memories, write durable facts.
// Token: OPENBRAIN_TOKEN env var, defaults to the dev token.
// URL:   OPENBRAIN_URL env var, defaults to localhost:3210.
// Both read and write are best-effort — failures are silently swallowed so
// the bot never breaks because OB is down.
// ---------------------------------------------------------------------------
const OB_URL   = (process.env.OPENBRAIN_URL ?? "http://localhost:3210").replace(/\/$/, "");
const OB_TOKEN = process.env.OPENBRAIN_TOKEN ?? "openbrain-dev-token";

async function obSearch(query: string, limit = 4): Promise<string[]> {
  try {
    const res = await fetch(`${OB_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OB_TOKEN}` },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as Array<{ content?: string }>;
    return data
      .map(d => (d.content ?? "").trim())
      .filter(c => c.length > 20 && c.length < 1200);
  } catch {
    return [];
  }
}

export async function obAdd(content: string, tags: string[] = [], source = "discord-bot"): Promise<void> {
  try {
    await fetch(`${OB_URL}/api/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OB_TOKEN}` },
      body: JSON.stringify({ content, source, tags }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // best-effort
  }
}

/**
 * Search OpenBrain for context relevant to the user's prompt.
 * Returns a compact string (≤800 chars) suitable for prompt injection.
 * Results below similarity threshold are discarded — low scores are noise.
 */
export async function getOpenBrainContext(prompt: string): Promise<string> {
  // Minimum similarity score to include a result. OB returns cosine similarity;
  // anything below 0.05 is effectively random noise in a large knowledge base.
  const MIN_SIMILARITY = 0.05;

  try {
    const res = await fetch(`${OB_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OB_TOKEN}` },
      body: JSON.stringify({ query: prompt, limit: 6 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "";
    const data = await res.json() as Array<{ content?: string; similarity?: number }>;
    const seen = new Set<string>();
    const snippets: string[] = [];
    let total = 0;
    for (const d of data) {
      if ((d.similarity ?? 0) < MIN_SIMILARITY) continue;
      const content = (d.content ?? "").trim();
      if (content.length < 20 || content.length > 1200) continue;
      const key = content.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const snip = content.slice(0, 300);
      if (total + snip.length > 800) break;
      snippets.push(snip);
      total += snip.length;
    }
    if (!snippets.length) return "";
    return snippets.map((s, i) => `[Memory ${i + 1}] ${s}`).join("\n");
  } catch {
    return "";
  }
}

/**
 * Save a notable exchange to OpenBrain so it survives across sessions.
 * Only called for facts / learnings — not every reply.
 */
export async function saveExchangeToOpenBrain(
  username: string,
  prompt: string,
  response: string,
  tags: string[] = [],
): Promise<void> {
  const content = `Discord exchange with ${username}:\nQ: ${prompt.slice(0, 300)}\nA: ${response.slice(0, 500)}`;
  await obAdd(content, ["discord", "exchange", ...tags], "discord-bot");
}

type Lesson = {
  kind: "avoid_generic" | "prefer_socratic" | "debate_signal" | "user_rule";
  message: string;
  answer?: string;
  createdAt: string;
  id?: string; // stable id for deletion, only on user_rule
};

type ConversationEntry = {
  channelId: string;
  userId: string;
  prompt: string;
  response: string;
  kind: "user_turn" | "assistant_turn" | "task_done" | "task_failed" | "task_timeout";
  taskId?: string;
  status: "done" | "failed" | "timeout";
  createdAt: string;
  // source="coordinator" means written by the bot itself — trusted for history injection.
  // Entries without this field (e.g. manual edits, test seeds) are excluded from injection
  // to prevent history poisoning attacks.
  source?: "coordinator";
};

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".agent-factory");
const MEMORY_FILE = process.env.DISCORD_LESSON_FILE
  ?? path.join(DEFAULT_DATA_DIR, "discord-lessons.json");
const MEMORY_DIR = path.dirname(MEMORY_FILE);
const MAX_LESSONS = 40;
const CONVERSATION_FILE = process.env.DISCORD_CONVERSATION_FILE
  ?? path.join(DEFAULT_DATA_DIR, "discord-conversations.json");
const CONVERSATION_DIR = path.dirname(CONVERSATION_FILE);
const MAX_CONVERSATIONS = 120;
const MAX_HISTORY_ITEMS = 10;

async function loadLessons(): Promise<Lesson[]> {
  try {
    const raw = await readFile(MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) as Lesson[] : [];
  } catch {
    return [];
  }
}

async function saveLessons(lessons: Lesson[]): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(MEMORY_FILE, JSON.stringify(lessons.slice(-MAX_LESSONS), null, 2), "utf8");
}

export async function recordDiscordLesson(lesson: Omit<Lesson, "createdAt">): Promise<void> {
  const lessons = await loadLessons();
  lessons.push({ ...lesson, createdAt: new Date().toISOString() });
  await saveLessons(lessons);
}

export async function getDiscordLessons(limit = 5): Promise<string> {
  const lessons = await loadLessons();
  const recent = lessons.slice(-limit);
  if (recent.length === 0) return "";
  return recent.map((l, i) => {
    const label =
      l.kind === "avoid_generic" ? "Avoid generic answers" :
      l.kind === "prefer_socratic" ? "Prefer Socratic friction" :
      "Debate signal";
    return `${i + 1}. ${label} for: ${l.message.slice(0, 180)}`;
  }).join("\n");
}

// --- User-authored behavior rules ---

export async function addUserRule(rule: string): Promise<string> {
  const lessons = await loadLessons();
  const id = `rule-${Date.now()}`;
  lessons.push({ kind: "user_rule", message: rule.trim(), createdAt: new Date().toISOString(), id });
  await saveLessons(lessons);
  return id;
}

export async function removeUserRule(query: string): Promise<boolean> {
  const lessons = await loadLessons();
  const q = query.toLowerCase();
  const before = lessons.length;
  // Match by id prefix, rule number (1-based), or substring of message
  const filtered = lessons.filter(l => {
    if (l.kind !== "user_rule") return true;
    if (l.id && l.id.startsWith(q)) return false;
    if (l.message.toLowerCase().includes(q)) return false;
    return true;
  });
  if (filtered.length === before) return false;
  await saveLessons(filtered);
  return true;
}

export async function getUserRules(): Promise<Lesson[]> {
  const lessons = await loadLessons();
  return lessons.filter(l => l.kind === "user_rule");
}

export async function getUserRulesText(): Promise<string> {
  const rules = await getUserRules();
  if (rules.length === 0) return "";
  return rules.map((r, i) => `${i + 1}. ${r.message}`).join("\n");
}

export async function recordDebateLesson(topic: string, synthesis: string, action?: string | null, provocation?: string | null): Promise<void> {
  const lessons = await loadLessons();
  const summaryParts = [
    `Topic: ${topic.slice(0, 160)}`,
    action ? `Action: ${action.slice(0, 220)}` : null,
    provocation ? `Provocation: ${provocation.slice(0, 220)}` : null,
    `Synthesis: ${synthesis.slice(0, 240)}`,
  ].filter(Boolean);
  lessons.push({
    kind: "debate_signal",
    message: summaryParts.join(" | "),
    answer: action ?? undefined,
    createdAt: new Date().toISOString(),
  });
  await saveLessons(lessons);
}

async function loadConversations(): Promise<ConversationEntry[]> {
  try {
    const raw = await readFile(CONVERSATION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) as ConversationEntry[] : [];
  } catch {
    return [];
  }
}

async function saveConversations(entries: ConversationEntry[]): Promise<void> {
  await mkdir(CONVERSATION_DIR, { recursive: true });
  await writeFile(CONVERSATION_FILE, JSON.stringify(entries.slice(-MAX_CONVERSATIONS), null, 2), "utf8");
}

export async function recordDiscordConversation(entry: Omit<ConversationEntry, "createdAt">): Promise<void> {
  const entries = await loadConversations();
  // Dedup: skip if we already have an entry with the same taskId (handles retries / dual-instance races)
  if (entry.taskId && entries.some(e => e.taskId === entry.taskId && e.kind === entry.kind)) {
    return;
  }
  // Tag as coordinator-sourced so history injection only trusts our own writes
  entries.push({ ...entry, source: "coordinator", createdAt: new Date().toISOString() });
  await saveConversations(entries);
}

export async function getDiscordConversationHistory(channelId: string, userId: string, limit = 6): Promise<string> {
  const entries = await loadConversations();
  const relevant = entries
    .filter(e =>
      e.channelId === channelId &&
      e.userId === userId &&
      !e.userId.startsWith("test:") &&
      e.source === "coordinator"
    )
    .slice(-limit);
  if (relevant.length === 0) return "";
  return relevant.map((e, i) => {
    const when = new Date(e.createdAt).toLocaleString();
    return `${i + 1}. [${when}] ${e.kind} ${e.status.toUpperCase()} ${e.prompt.slice(0, 160)} -> ${e.response.slice(0, 220)}`;
  }).join("\n");
}

export async function getRecentConversationSummary(channelId: string, userId: string, limit = MAX_HISTORY_ITEMS): Promise<string> {
  const entries = await loadConversations();
  const fileEntries = entries.filter(e =>
    e.channelId === channelId &&
    e.userId === userId &&
    !e.userId.startsWith("test:") &&
    e.source === "coordinator"
  ).slice(-limit);

  // Supplement with recently completed DB tasks not yet flushed to the conversation file.
  // Fixes fast follow-up context loss: if user sends B before A's assistant_turn is written,
  // the DB already has A's result while the file doesn't.
  const fileTaskIds = new Set(fileEntries.map(e => e.taskId).filter(Boolean));
  type DbRow = { task_id: string; prompt_raw: string; result: string; completed_at: string };
  let dbExtras: string[] = [];
  try {
    const res = await pool.query<DbRow>(
      `SELECT id AS task_id,
              payload->>'prompt' AS prompt_raw,
              result,
              completed_at::text
       FROM agent_tasks
       WHERE payload->>'discord_channel_id' = $1
         AND payload->>'discord_user_id'    = $2
         AND status = 'done'
         AND completed_at > now() - interval '10 minutes'
       ORDER BY completed_at ASC
       LIMIT $3`,
      [channelId, userId, limit]
    );
    dbExtras = res.rows
      .filter(r => !fileTaskIds.has(r.task_id))  // skip what's already in the file
      .map(r => {
        const when = new Date(r.completed_at).toLocaleString();
        const prompt = (r.prompt_raw ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
        const response = (r.result ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
        return `[${when}] assistant_turn/done: ${prompt} => ${response}`;
      });
  } catch {
    // DB supplement is best-effort; file history still works
  }

  const fileLines = fileEntries.map((entry, index) => {
    const when = new Date(entry.createdAt).toLocaleString();
    const prompt = entry.prompt.replace(/\s+/g, " ").trim();
    const response = entry.response.replace(/\s+/g, " ").trim();
    return `${index + 1}. [${when}] ${entry.kind}/${entry.status}: ${prompt.slice(0, 150)} => ${response.slice(0, 180)}`;
  });

  const all = [...fileLines, ...dbExtras];
  if (all.length === 0) return "";
  return all.join("\n");
}

/**
 * Returns a warning string if the conversation history was truncated, else "".
 * Only counts entries from the last 24 hours — avoids false positives from old sessions.
 */
export async function getConversationTruncationWarning(channelId: string, userId: string, limit = MAX_HISTORY_ITEMS): Promise<string> {
  const entries = await loadConversations();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentRelevant = entries.filter(e =>
    e.channelId === channelId &&
    e.userId === userId &&
    !e.userId.startsWith("test:") &&
    e.source === "coordinator" &&
    new Date(e.createdAt) > cutoff
  );
  if (recentRelevant.length <= limit) return "";
  return `⚠️ *Context limited to last ${limit} messages — older context not visible.*`;
}
