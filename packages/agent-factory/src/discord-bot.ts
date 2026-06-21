import {
  Client, GatewayIntentBits, Message, Events,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder,
} from "discord.js";
import pool, { getBoss } from "./db.js";
import { extractProposedAction, extractProvocation } from "./debate.js";
import { kickAdvisor, inviteAdvisor, getRosterText } from "./roster.js";
import { HELP_TEXT } from "./help.js";
import { buildIntentPrompt, classifyDiscordIntent, needsWebSearch } from "./discord-intents.js";
import { buildSocraticAnswerPrompt, buildSocraticDecisionPrompt } from "./socratic.js";
import { getConversationTruncationWarning, recordDiscordConversation, recordDiscordLesson, addUserRule, removeUserRule, getUserRules, obAdd, saveExchangeToOpenBrain } from "./discord-memory.js";

let botClient: Client | null = null;

const BOT_TOKEN      = process.env.DISCORD_BOT_TOKEN      ?? "";
const ALLOWED_CHANNEL = process.env.DISCORD_TASK_CHANNEL_ID ?? "";

// Load context hints from env — lets users inject project knowledge without code changes
// Format: JSON array of {pattern: string, context: string}
// e.g. CONTEXT_HINTS_JSON=[{"pattern":"myproject","context":"MyProject is a..."}]
const CONTEXT_HINTS: Array<{ pattern: RegExp; context: string }> = (() => {
  try {
    const raw = process.env.CONTEXT_HINTS_JSON;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ pattern: string; context: string }>;
    return parsed.map(h => ({ pattern: new RegExp(h.pattern, "i"), context: h.context }));
  } catch {
    return [];
  }
})();

// ---------------------------------------------------------------------------
// Per-channel config — supports model_override to enforce Claude-only channels.
// Set CHANNEL_CONFIG_JSON env var:
//   '{"<channelId>": {"model_override": "claude", "name": "ops"}}'
// Any channel with model_override="claude" always routes through Claude regardless
// of needsClaude() routing logic. Other fields ignored for now.
// ---------------------------------------------------------------------------
type ChannelConfig = { model_override?: "claude" | "beast" | "auto"; name?: string };
const CHANNEL_CONFIGS: Record<string, ChannelConfig> = (() => {
  try {
    const raw = process.env.CHANNEL_CONFIG_JSON;
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ChannelConfig>;
  } catch {
    console.warn("[discord-bot] CHANNEL_CONFIG_JSON parse failed — using defaults");
    return {};
  }
})();

function getChannelModelOverride(channelId: string): string | null {
  return CHANNEL_CONFIGS[channelId]?.model_override ?? null;
}

// ---------------------------------------------------------------------------
// Prompt response cache — deduplicates identical prompts within CACHE_TTL_MS.
// Keyed on (channelId + normalised prompt). Saves API cost for repeat questions.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000; // 60 seconds
const _promptCache = new Map<string, { result: string; ts: number }>();

function getCachedResponse(channelId: string, prompt: string): string | null {
  const key = channelId + "\x00" + prompt.trim().toLowerCase().replace(/\s+/g, " ");
  const entry = _promptCache.get(key);
  if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.result;
}

function setCachedResponse(channelId: string, prompt: string, result: string): void {
  const key = channelId + "\x00" + prompt.trim().toLowerCase().replace(/\s+/g, " ");
  _promptCache.set(key, { result, ts: Date.now() });
  // Prune entries older than 5× TTL to avoid unbounded growth
  const cutoff = Date.now() - CACHE_TTL_MS * 5;
  for (const [k, v] of _promptCache) {
    if (v.ts < cutoff) _promptCache.delete(k);
  }
}

type Sendable = { send: (content: any) => Promise<any> };

async function fetchWebContext(query: string): Promise<string> {
  try {
    // DuckDuckGo instant answers — no API key required
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const res = await fetch(ddgUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return "";
    const data = await res.json() as {
      AbstractText?: string;
      Answer?: string;
      RelatedTopics?: { Text?: string }[];
    };
    const parts: string[] = [];
    if (data.Answer) parts.push(`Answer: ${data.Answer}`);
    if (data.AbstractText) parts.push(`Summary: ${data.AbstractText}`);
    if (!parts.length && data.RelatedTopics?.length) {
      const snippets = data.RelatedTopics.slice(0, 3).map(t => t.Text).filter(Boolean);
      if (snippets.length) parts.push(`Related: ${snippets.join(" | ")}`);
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

async function fetchUrlContent(url: string): Promise<string> {
  try {
    // Try Jina Reader first — renders JS, returns clean markdown
    const jinaUrl = `https://r.jina.ai/${url}`;
    const jinaRes = await fetch(jinaUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/plain" },
    });
    if (jinaRes.ok) {
      const text = await jinaRes.text();
      if (text.length > 200) return text.slice(0, 3000);
    }

    // Fallback: raw HTML with aggressive tag stripping + og:description extraction
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return "";
    const html = await res.text();
    // Pull og:description / meta description first (most reliable for social pages)
    const metaMatch = html.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]{20,})"/i)
      ?? html.match(/<meta[^>]+content="([^"]{20,})"[^>]+(?:property="og:description"|name="description")/i);
    if (metaMatch) return `Page summary: ${metaMatch[1].trim()}`;
    // Last resort: strip tags
    const text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    return text;
  } catch {
    return "";
  }
}

function looksGenericAnswer(text: string): boolean {
  // Only flag genuinely useless filler responses, not long/structured answers
  return /improve conversational flow|add nlp|research frameworks|allocate \d+ weeks? to research/i.test(text)
    && text.length < 600;
}

async function rewriteGenericAnswer(userPrompt: string, answer: string): Promise<string> {
  if (!looksGenericAnswer(answer)) return answer;
  void recordDiscordLesson({ kind: "avoid_generic", message: userPrompt, answer }).catch(() => {});

  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

  try {
    const res = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        prompt: [
          buildSocraticAnswerPrompt(userPrompt, answer),
        ].join("\n\n"),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return answer;
    const data = await res.json() as { response?: string };
    const rewritten = data.response?.trim();
    return rewritten || answer;
  } catch {
    return answer;
  }
}

function summarizeResult(text: string, max = 400): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

async function pollAndPost(channel: Sendable, taskId: string): Promise<void> {
  const maxWait = 120_000;
  const interval = 3_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    const res = await pool.query<{ status: string; result: string; error: string }>(
      `SELECT status, result, error FROM agent_tasks WHERE id = $1`, [taskId]
    );
    const row = res.rows[0];
    if (!row) return;
    if (row.status === "done") {
      const preview = row.result.length > 1900 ? row.result.slice(0, 1900) + "…" : row.result;
      await channel.send(`✅ ${preview}`);
      return;
    }
    if (row.status === "failed") {
      await channel.send(`❌ \`${row.error?.slice(0, 300) ?? "unknown error"}\``);
      return;
    }
  }
  await channel.send("⏱️ Task timed out.");
}

/** Post a plain text message to a channel — used by coordinator dead-letter handler. */
export async function postToChannel(channelId: string, content: string): Promise<void> {
  if (!botClient) return;
  const channel = botClient.channels.cache.get(channelId) as (Sendable | null) | undefined;
  if (!channel) return;
  try {
    await channel.send(content.length > 1990 ? content.slice(0, 1990) + "…" : content);
  } catch (err: any) {
    console.error("[discord-bot] postToChannel error:", err?.message);
  }
}

export async function postDebateAction(
  taskId: string,
  proposedAction: string,
  topic: string,
  channelId?: string,
  provocation?: string | null,
): Promise<void> {
  const ch = channelId ?? ALLOWED_CHANNEL;
  if (!botClient || !ch) return;

  const channel = botClient.channels.cache.get(ch) as (Sendable | null) | undefined;
  if (!channel) return;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Topic", value: topic.slice(0, 200) },
    { name: "Proposed Action", value: proposedAction.slice(0, 500) },
  ];
  if (provocation) {
    fields.push({ name: "❓ Open Question", value: provocation.slice(0, 400) });
  }
  fields.push({ name: "Task", value: `\`${taskId.slice(0, 8)}\``, inline: true });

  const embed = new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle("🗳️ Debate Verdict — Proposed Action")
    .addFields(...fields)
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`debate_approve_${taskId}`).setLabel("✅ Approve & Execute").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`debate_reject_${taskId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`debate_ask_${taskId}`).setLabel("🔍 Ask Claude").setStyle(ButtonStyle.Secondary),
  );

  try {
    await channel.send({ embeds: [embed], components: [row] });
  } catch (err: any) {
    console.error("[discord-bot] postDebateAction error:", err?.message);
  }
}

async function queueTask(from: string, to_agent: string, type: string, payload: Record<string, any>): Promise<string> {
  // Insert into agent_tasks first so Discord reply polling (waitAndReply) can track status
  const res = await pool.query<{ id: string }>(`
    INSERT INTO agent_tasks (from_agent, to_agent, type, payload, priority)
    VALUES ($1, $2, $3, $4, 3)
    RETURNING id
  `, [from, to_agent, type, JSON.stringify(payload)]);
  const taskId = res.rows[0].id;

  // Enqueue in pg-boss for exactly-once delivery, retries, and stale recovery
  // Codex tasks have their own runner — skip pg-boss
  if (to_agent !== "codex") {
    const boss = await getBoss();
    await boss.send("agent-tasks", { taskId }, {
      id: taskId,          // UUID as job key → singleton dedup
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 600,
    });
  }

  return taskId;
}

// Detects natural teaching intent and extracts the rule.
// Only matches explicit behavioral instructions to avoid false positives.
function extractNaturalRule(content: string): string | null {
  const t = content.trim();

  // "remember to ..." / "remember that ..."
  const rememberMatch = t.match(/^remember\s+(?:to\s+|that\s+)(.+)/i);
  if (rememberMatch) return rememberMatch[1].trim();

  // "from now on ..." / "going forward ..."
  const fromNowMatch = t.match(/^(?:from now on|going forward|in the future)[,\s]+(.+)/i);
  if (fromNowMatch) return fromNowMatch[1].trim();

  // "always ..." / "never ..." — but only at the start, short-form instructions
  const alwaysNeverMatch = t.match(/^(always|never)\s+(.+)/i);
  if (alwaysNeverMatch && t.length < 200 && !/[?]/.test(t)) return t;

  // "stop ..." / "don't ..." / "do not ..." — clear behavioral corrections
  const stopMatch = t.match(/^(?:stop|don'?t|do not|please stop|please don'?t)\s+(.+)/i);
  if (stopMatch && t.length < 200 && !/[?]/.test(t)) return t;

  // "keep responses ..." / "keep answers ..."
  const keepMatch = t.match(/^keep\s+(?:your\s+)?(?:responses?|answers?|replies?)\s+(.+)/i);
  if (keepMatch) return t;

  return null;
}

function isDirectQuestion(content: string): boolean {
  const text = content.trim();
  return /[?]\s*$/.test(text) || /^(what|why|how|which|who|where|when|is it|are we|should we|can we|does this|do you think|opinion on)\b/i.test(text);
}

function isAmbiguousMessage(_content: string): boolean {
  // Disabled — let Beast handle everything including short messages and greetings
  return false;
}

function clarificationPrompt(content: string): string {
  const text = content.trim();
  if (/^(help|question|thoughts|opinions?)\b/i.test(text)) {
    return "What exactly do you want me to do with that?";
  }
  if (text.length < 18) {
    return "What should I do with this?";
  }
  return "What part do you want me to focus on: summary, opinion, comparison, or next action?";
}

function buildRepairPrompt(userPrompt: string, recentHistory: string, recentLessons: string): string {
  return [
    "The user is issuing a repair command.",
    "Do not ask for clarification unless absolutely necessary.",
    "Use the recent failure chain, conversation history, and lessons to identify the likely broken path.",
    "Respond with the concrete fix or the smallest repair plan, then the next action.",
    recentHistory ? `Recent Discord conversation history:\n${recentHistory}` : "",
    recentLessons ? `Recent Discord lessons:\n${recentLessons}` : "",
    `User message: ${userPrompt}`,
  ].filter(Boolean).join("\n");
}

function isNaturalRetryRequest(content: string): boolean {
  const text = content.trim().toLowerCase();
  return /^(please\s+)?(retry|try again|try ag[ie]n|again|run it again|do it again|redo that|try that again)!?$/.test(text)
    || /\n\s*(please\s+)?(retry|try again|try ag[ie]n|again|run it again|do it again|redo that|try that again)!?\s*$/.test(text);
}

async function healthyBeastOrLocal(): Promise<"beast" | "local" | null> {
  try {
    const beastBase = process.env.BEAST_URL ?? "http://localhost:8081";
    const beastHealth = process.env.BEAST_HEALTH_URL ?? `${beastBase.replace(/\/$/, "")}/health`;
    if (beastHealth) {
      const res = await fetch(beastHealth, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return "beast";
    }
  } catch {}

  try {
    const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
    if (ollamaUrl) {
      const res = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return "local";
    }
  } catch {}

  return null;
}

async function retryLastTask(message: Message, partialId?: string): Promise<boolean> {
  const row = partialId
    ? await pool.query<{ id: string; to_agent: string; type: string; payload: any }>(
        `SELECT id, to_agent, type, payload FROM agent_tasks WHERE id::text LIKE $1 ORDER BY created_at DESC LIMIT 1`,
        [`${partialId}%`]
      )
    : await pool.query<{ id: string; to_agent: string; type: string; payload: any }>(
        `SELECT id, to_agent, type, payload FROM agent_tasks WHERE from_agent = $1 ORDER BY created_at DESC LIMIT 1`,
        [`discord:${message.author.username}`]
      );
  if (!row.rows.length) {
    await message.reply(partialId ? `No task found matching \`${partialId}\`` : "No previous task found for your account.");
    return false;
  }
  const orig = row.rows[0];
  const preferred = await healthyBeastOrLocal();
  const retryAgent =
    orig.to_agent === "auto"
      ? (preferred ?? "claude")
      : orig.to_agent;
  const newId = await queueTask(`discord:${message.author.username}`, retryAgent, orig.type, {
    ...orig.payload,
    discord_channel_id: message.channelId,
    _roster_ctx: message.channelId,
    prompt: String(orig.payload?.prompt ?? ""),
  });
  await message.react("🔄");
  console.log(`[discord-bot] retry: cloned ${orig.id.slice(0, 8)} → ${newId.slice(0, 8)}`);
  return true;
}

// --- Outcome Memory helpers ---

interface BoardSession {
  id: string;
  topic: string;
  proposed_action: string | null;
  created_at: Date;
}

interface InboxItem {
  id: string;
  topic: string;
  status: string;
  created_at: Date;
}

async function getPendingCheckIns(userId: string): Promise<{ session: BoardSession; checkInDays: number }[]> {
  const now = new Date();
  const results: { session: BoardSession; checkInDays: number }[] = [];

  for (const days of [30, 60, 90]) {
    const lo = new Date(now.getTime() - (days + 2) * 86_400_000);
    const hi = new Date(now.getTime() - (days - 2) * 86_400_000);
    const res = await pool.query<BoardSession>(
      `SELECT bs.id, bs.topic, bs.proposed_action, bs.created_at
       FROM board_sessions bs
       WHERE bs.user_id = $1
         AND bs.created_at BETWEEN $2 AND $3
         AND NOT EXISTS (
           SELECT 1 FROM board_outcomes bo
           WHERE bo.session_id = bs.id AND bo.check_in_days = $4
         )
       ORDER BY bs.created_at ASC`,
      [userId, lo, hi, days]
    );
    for (const row of res.rows) results.push({ session: row, checkInDays: days });
  }
  return results;
}

async function getUserInbox(userId: string): Promise<InboxItem[]> {
  const res = await pool.query<InboxItem>(
    `SELECT id, topic, status, created_at
     FROM board_inbox
     WHERE user_id = $1 AND status NOT IN ('closed')
     ORDER BY created_at ASC`,
    [userId]
  );
  return res.rows;
}

async function addToInbox(channelId: string, userId: string, topic: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO board_inbox (channel_id, user_id, topic) VALUES ($1, $2, $3) RETURNING id`,
    [channelId, userId, topic]
  );
  return res.rows[0].id;
}

async function findSessionByPrefix(userId: string, prefix: string): Promise<BoardSession | null> {
  const res = await pool.query<BoardSession>(
    `SELECT id, topic, proposed_action, created_at
     FROM board_sessions
     WHERE user_id = $1 AND id::text LIKE $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, `${prefix}%`]
  );
  return res.rows[0] ?? null;
}

// --- Board inbox natural language detection ---

function extractInboxTopic(content: string): string | null {
  const m = content.match(
    /(?:add to board inbox|add to board|remind me to board|queue for the board)[:\s]+(.+)/i
  );
  return m ? m[1].trim() : null;
}

// !board [advisorA advisorB ...]: topic  — board of advisors mode (auto-selects if no names given)
// !debate [agentA vs agentB [N]] [--red agentName] [--socratic agentName]: topic
// !beast: / !local: / !gemini: / !claude: / !codex: prompt
// anything else → auto-route as chat
function parseCommand(content: string): { to_agent: string; type: string; prompt: string; extra?: Record<string, any> } {
  // !board plan: topic  or  !plan: topic — dry run, no LLM calls
  const boardPlanMatch = content.match(/^(?:!board\s+plan|!plan):\s*([\s\S]+)/i);
  if (boardPlanMatch) {
    return { to_agent: "auto", type: "board_plan", prompt: boardPlanMatch[1].trim(), extra: {} };
  }

  // !board [cfo cmo ...]: topic
  const boardMatch = content.match(/^!board(?:\s+([\w\s]+?))?:\s*([\s\S]+)/i);
  if (boardMatch) {
    const rawIds = boardMatch[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    const topic  = boardMatch[2].trim();
    const hint   = CONTEXT_HINTS.find(h => h.pattern.test(topic));
    return {
      to_agent: "auto",
      type: "board",
      prompt: topic,
      extra: {
        ...(rawIds.length ? { advisor_ids: rawIds } : {}),
        ...(hint ? { context: hint.context } : {}),
      },
    };
  }

  const debateMatch = content.match(/^!debate(?:\s+(.+?))?:\s*([\s\S]+)/i);
  if (debateMatch) {
    const optStr = debateMatch[1] ?? "";
    const topic  = debateMatch[2].trim();

    const redMatch      = optStr.match(/--red\s+([\w]+)/i);
    const socraticMatch = optStr.match(/--socratic\s+([\w]+)/i);
    const cleanOpts     = optStr.replace(/--\w+\s+[\w]+/gi, "").trim();
    const agentsPart    = cleanOpts.match(/([\w]+(?:\s+vs\s+[\w]+)+)/i)?.[1];
    const roundsPart    = cleanOpts.split(/\s+/).find(p => /^\d+$/.test(p));

    const isAll    = /^all$/i.test(cleanOpts.replace(/\d+/g, "").trim());
    const agents   = isAll ? ["claude", "beast", "canoe", "gemini", "codex", "kimi"]
                   : agentsPart ? agentsPart.toLowerCase().split(/\s+vs\s+/).map(s => s.trim())
                   : ["claude", "local"];
    const rounds   = roundsPart ? parseInt(roundsPart, 10) : undefined;
    const red_team = redMatch?.[1]?.toLowerCase();
    const socratic = socraticMatch?.[1]?.toLowerCase();
    const hint     = CONTEXT_HINTS.find(h => h.pattern.test(topic));
    return {
      to_agent: "auto",
      type: "debate",
      prompt: topic,
      extra: {
        agents,
        ...(rounds   ? { rounds }   : {}),
        ...(red_team ? { red_team } : {}),
        ...(socratic ? { socratic } : {}),
        ...(hint     ? { context: hint.context } : {}),
      },
    };
  }

  const agentMatch = content.match(/^!(beast|gemini|local|claude|codex|openai):\s*([\s\S]+)/i);
  if (agentMatch) {
    return { to_agent: agentMatch[1].toLowerCase(), type: "chat", prompt: agentMatch[2].trim() };
  }

  // Unknown agent prefix — e.g. !gpt99: — warn instead of silently routing to Claude
  const unknownAgentMatch = content.match(/^!([\w]+):\s*([\s\S]*)/);
  const KNOWN_CMDS = new Set(["help","teach","forget","rules","kick","invite","roster",
    "checkin","outcome","backtest","queue","inbox","board","debate","search",
    "web","google","lookup","board-inbox","close","add"]);
  if (unknownAgentMatch && !KNOWN_CMDS.has(unknownAgentMatch[1].toLowerCase())) {
    return { to_agent: "_unknown_", type: "chat", prompt: unknownAgentMatch[2].trim() || "__empty__",
             extra: { _unknown_agent: unknownAgentMatch[1] } };
  }

  const searchMatch = content.match(/^!(?:search|web|google|lookup):\s*([\s\S]+)/i);
  if (searchMatch) {
    return { to_agent: "auto", type: "chat", prompt: searchMatch[1].trim(), extra: { web_search: true } };
  }

  const intent = classifyDiscordIntent(content);
  if (intent === "board" || intent === "debate") {
    return { to_agent: "auto", type: intent, prompt: content.trim() };
  }
  return { to_agent: "auto", type: "chat", prompt: buildIntentPrompt(content) };
}

async function waitAndReply(client: Client, message: Message, taskId: string, truncationWarning = "", originalPrompt = ""): Promise<void> {
  const maxWait = 120_000;
  const interval = 3_000;
  const start = Date.now();
  let progressMessage: Message | null = null;
  let statusUpdated = false;

  try {
    progressMessage = await message.reply("Thinking…");
  } catch {
    progressMessage = null;
  }

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    const res = await pool.query<{ status: string; result: string; error: string; to_agent: string }>(
      `SELECT status, result, error, to_agent FROM agent_tasks WHERE id = $1`, [taskId]
    );
    const row = res.rows[0];
    if (!row) return;

    // On first claimed poll, update the progress message with agent-specific status
    if (!statusUpdated && row.status === "claimed" && progressMessage) {
      const agentLabel = (row.to_agent === "beast" || row.to_agent === "local")
        ? "🤖 Asking Beast…"
        : "🧠 Thinking with Claude…";
      await progressMessage.edit(agentLabel).catch(() => {});
      statusUpdated = true;
    }

    if (row.status === "done") {
      const finalResult = await rewriteGenericAnswer(message.content, row.result);
      const warningPrefix = truncationWarning ? `${truncationWarning}\n\n` : "";
      const combined = warningPrefix + finalResult;
      const preview = combined.length > 1900 ? combined.slice(0, 1900) + "…" : combined;
      // Populate prompt cache for dedup within CACHE_TTL_MS
      if (originalPrompt) setCachedResponse(message.channelId, originalPrompt, finalResult);
      void recordDiscordConversation({
        channelId: message.channelId,
        userId: message.author.id,
        prompt: message.content.trim(),
        response: summarizeResult(finalResult),
        taskId,
        kind: "assistant_turn",
        status: "done",
      }).catch(() => {});
      // Write durable facts to OpenBrain when the user shared something worth remembering.
      // Heuristic: prompts that introduce information (my name is, I work at, my project, etc.)
      const userMsg = message.content.trim();
      const isDurableFact = /\b(my name is|I('m| am)|I work|my project|my company|my team|I'm building|my goal|my role|codename is|I prefer|I want you to|remember that|for context)\b/i.test(userMsg);
      if (isDurableFact) {
        const username = message.author.displayName ?? message.author.username;
        void saveExchangeToOpenBrain(username, userMsg, finalResult, ["discord", "user-fact"]).catch(() => {});
      }
      if (progressMessage) {
        await progressMessage.edit(`✅ ${preview}`).catch(async () => {
          await message.reply(`✅ ${preview}`).catch(() => {});
        });
      } else {
        await message.reply(`✅ ${preview}`).catch(() => {});
      }
      return;
    }
    if (row.status === "failed") {
      const errText = `❌ \`${row.error?.slice(0, 300) ?? "unknown error"}\``;
      void recordDiscordConversation({
        channelId: message.channelId,
        userId: message.author.id,
        prompt: message.content.trim(),
        response: summarizeResult(row.error ?? "unknown error"),
        taskId,
        kind: "task_failed",
        status: "failed",
      }).catch(() => {});
      if (progressMessage) {
        await progressMessage.edit(errText).catch(async () => {
          await message.reply(errText).catch(() => {});
        });
      } else {
        await message.reply(errText).catch(() => {});
      }
      return;
    }
  }
  const timeoutText = "⏱️ Task timed out.";
  void recordDiscordConversation({
    channelId: message.channelId,
    userId: message.author.id,
    prompt: message.content.trim(),
    response: "Task timed out after waiting for a result.",
    taskId,
    kind: "task_timeout",
    status: "timeout",
  }).catch(() => {});
  if (progressMessage) {
    await progressMessage.edit(timeoutText).catch(async () => {
      await message.reply(timeoutText).catch(() => {});
    });
  } else {
    await message.reply(timeoutText).catch(() => {});
  }
}

export function startDiscordBot(): void {
  if (!BOT_TOKEN) {
    console.log("[discord-bot] DISCORD_BOT_TOKEN not set — bot disabled");
    return;
  }

  let lastEventAt = Date.now();
  const STALE_MS = 20 * 60 * 1000; // 20 minutes without any gateway event = reconnect

  function makeClient(): Client {
    const c = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    return c;
  }

  async function connect(c: Client): Promise<void> {
    await c.login(BOT_TOKEN);
  }

  async function reconnect(c: Client, reason: string): Promise<void> {
    console.log(`[discord-bot] reconnecting — ${reason}`);
    try { c.destroy(); } catch {}
    const fresh = makeClient();
    wireHandlers(fresh);
    try {
      await connect(fresh);
    } catch (err: any) {
      console.error("[discord-bot] reconnect failed:", err?.message, "— will retry in 30s");
      setTimeout(() => reconnect(fresh, "retry after failed reconnect"), 30_000);
    }
  }

  function wireHandlers(c: Client): void {
    c.once(Events.ClientReady, () => {
      botClient = c;
      lastEventAt = Date.now();
      console.log(`[discord-bot] logged in as ${c.user?.tag}`);
    });

    c.on(Events.ShardDisconnect, (_, shardId) => {
      console.warn(`[discord-bot] shard ${shardId} disconnected — reconnecting`);
      void reconnect(c, "ShardDisconnect");
    });

    c.on(Events.ShardError, (err) => {
      console.error("[discord-bot] shard error:", err?.message);
    });

    // Heartbeat: bump timestamp on any gateway event so we know events are flowing
    c.on("raw" as any, () => { lastEventAt = Date.now(); });

    wireMessageHandler(c);
    wireInteractionHandler(c);
  }

  // Watchdog: if no gateway event for 20 min, the WS is zombie — reconnect
  setInterval(() => {
    const staleMs = Date.now() - lastEventAt;
    if (staleMs > STALE_MS) {
      console.warn(`[discord-bot] gateway silent for ${Math.round(staleMs / 60_000)}m — forcing reconnect`);
      const current = botClient;
      if (current) void reconnect(current, "watchdog stale gateway");
    }
  }, 5 * 60 * 1000); // check every 5 min

  const client = makeClient();
  wireHandlers(client);

  function wireInteractionHandler(c: Client): void { c.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const { customId } = interaction;

    try {
      if (customId.startsWith("debate_approve_")) {
        const taskId = customId.slice("debate_approve_".length);
        const res = await pool.query<{ result: string }>(
          `SELECT result FROM agent_tasks WHERE id = $1`, [taskId]
        );
        const proposed = res.rows[0] ? extractProposedAction(res.rows[0].result ?? "") : null;
        if (proposed) {
          const execId = await queueTask(`discord:${interaction.user.username}`, "auto", "chat", { prompt: `Execute this approved action: ${proposed}` });
          await interaction.update({ content: `✅ Approved — executing as task \`${execId.slice(0, 8)}\``, components: [] });
          if (interaction.channel) void pollAndPost(interaction.channel as unknown as Sendable, execId);
        } else {
          await interaction.update({ content: "✅ Approved — no executable action found", components: [] });
        }
      } else if (customId.startsWith("debate_reject_")) {
        await interaction.update({ content: "❌ Rejected — no action taken", components: [] });
      } else if (customId.startsWith("debate_ask_")) {
        const taskId = customId.slice("debate_ask_".length);
        const res = await pool.query<{ result: string }>(
          `SELECT result FROM agent_tasks WHERE id = $1`, [taskId]
        );
        const synthesis = res.rows[0]?.result ?? "";
        const askId = await queueTask(
          `discord:${interaction.user.username}`, "claude", "chat",
          { prompt: `Based on this debate synthesis, what are the key open questions, risks, and follow-up considerations?\n\n${synthesis.slice(0, 1500)}` }
        );
        await interaction.update({ content: `🔍 Asking Claude — task \`${askId.slice(0, 8)}\``, components: [] });
        if (interaction.channel) void pollAndPost(interaction.channel as unknown as Sendable, askId);
      }
    } catch (err: any) {
      console.error("[discord-bot] interaction error:", err?.message);
      if (!interaction.replied) {
        await interaction.reply({ content: "❌ Error handling action", ephemeral: true }).catch(() => {});
      }
    }
  }); }

  function wireMessageHandler(c: Client): void { c.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!message.content.trim()) return;
    if (ALLOWED_CHANNEL && message.channelId !== ALLOWED_CHANNEL) return;

    // Normalize fullwidth ！ (U+FF01) — CJK keyboards auto-convert, which breaks command parsing.
    // Strip null bytes — Postgres throws 22P05 if they reach a JSON column.
    const content = message.content.trim().replace(/！/g, "!").replace(/\u0000/g, "");
    if (!content) return; // was all null bytes / whitespace
    const ctx = message.channelId;
    const userId = `discord:${message.author.username}`;

    void recordDiscordConversation({
      channelId: message.channelId,
      userId: message.author.id,
      prompt: content,
      response: "",
      kind: "user_turn",
      status: "done",
    }).catch(() => {});

    // Inline: time/date questions — answer immediately without queuing
    if (/^(what('?s| is) (the )?(time|current time|date|today|day|year)|what time is it|what day is it|what('?s| is) today)\??$/i.test(content)) {
      const now = new Date();
      const timeStr = now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
      await message.reply(timeStr + " ET");
      return;
    }

    // Help + roster management — handled inline, no task queue needed
    if (/^!help\b/i.test(content)) { await message.reply(HELP_TEXT); return; }

    const kickMatch = content.match(/^!kick\s+([\w]+)/i);
    if (kickMatch) { await message.reply(kickAdvisor(kickMatch[1], ctx)); return; }

    const inviteMatch = content.match(/^!invite\s+([\w]+)/i);
    if (inviteMatch) { await message.reply(inviteAdvisor(inviteMatch[1], ctx)); return; }

    if (/^!roster\b/i.test(content)) { await message.reply(getRosterText(ctx)); return; }

    // Self-improvement: explicit commands
    const teachMatch = content.match(/^!teach[:\s]+(.+)/is);
    if (teachMatch) {
      const rule = teachMatch[1].trim();
      await addUserRule(rule);
      const username = message.author.displayName ?? message.author.username;
      void obAdd(
        `Discord user rule from ${username}: ${rule}`,
        ["discord", "user-rule", "teach"],
        "discord-bot",
      ).catch(() => {});
      await message.reply(`✅ Got it: "${rule.slice(0, 120)}"`);
      return;
    }

    const forgetMatch = content.match(/^!forget[:\s]+(.+)/is);
    if (forgetMatch) {
      const removed = await removeUserRule(forgetMatch[1].trim());
      await message.reply(removed ? "✅ Rule removed." : "❌ No matching rule found — use `!rules` to see what's saved.");
      return;
    }

    if (/^!rules\b/i.test(content)) {
      const rules = await getUserRules();
      if (rules.length === 0) {
        await message.reply("No behavior rules saved yet. Just tell me naturally — e.g. \"remember to always keep responses short\".");
      } else {
        const list = rules.map((r, i) => `**${i + 1}.** ${r.message}`).join("\n");
        await message.reply(`**Current behavior rules:**\n${list}`);
      }
      return;
    }

    // --- Outcome Memory commands ---

    // !checkin — show board sessions that are ~30, 60, or 90 days old with no outcome recorded
    if (/^!checkin\b/i.test(content)) {
      try {
        const pending = await getPendingCheckIns(userId);
        if (pending.length === 0) {
          await message.reply("No pending check-ins right now. Check back around day 28-32, 58-62, or 88-92 after a board session.");
          return;
        }
        const lines = pending.map(({ session, checkInDays }) => {
          const prefix = session.id.slice(0, 8);
          const when = new Date(session.created_at).toLocaleDateString();
          const action = session.proposed_action ? `\n  Proposed action: ${session.proposed_action.slice(0, 200)}` : "";
          return `**${checkInDays} days ago** (${when}) — \`${prefix}\`\nTopic: ${session.topic.slice(0, 200)}${action}\nReply: \`!outcome ${prefix} [your notes]\``;
        });
        await message.reply(`**Board session check-ins:**\n\n${lines.join("\n\n")}`);
      } catch (err: any) {
        console.error("[discord-bot] !checkin error:", err?.message);
        await message.reply("❌ Error fetching check-ins.");
      }
      return;
    }

    // Natural language rule detection — no command prefix needed
    const naturalRule = extractNaturalRule(content);
    if (naturalRule) {
      await addUserRule(naturalRule);
      await message.reply(`✅ Got it — I'll remember that: "${naturalRule.slice(0, 120)}"`);
      return;
    }

    if (isNaturalRetryRequest(content)) {
      await retryLastTask(message);
      return;
    }

    // !outcome [session-prefix] [text] — record an outcome for a board session
    const outcomeMatch = content.match(/^!outcome\s+([a-f0-9-]+)\s+([\s\S]+)/i);
    if (outcomeMatch) {
      const prefix = outcomeMatch[1].trim();
      const text   = outcomeMatch[2].trim();
      try {
        const session = await findSessionByPrefix(userId, prefix);
        if (!session) {
          await message.reply(`❌ No board session found matching \`${prefix}\`. Use \`!checkin\` to see pending sessions.`);
          return;
        }
        // Determine check-in bucket (closest to 30/60/90 that has no outcome yet)
        const ageMs = Date.now() - new Date(session.created_at).getTime();
        const ageDays = Math.round(ageMs / 86_400_000);
        const bucket = [30, 60, 90].reduce((best, d) => Math.abs(d - ageDays) < Math.abs(best - ageDays) ? d : best, 30);
        await pool.query(
          `INSERT INTO board_outcomes (session_id, check_in_days, outcome_text, recorded_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT DO NOTHING`,
          [session.id, bucket, text]
        );
        await message.reply(`✅ Outcome recorded for session \`${session.id.slice(0, 8)}\` (${bucket}-day check-in): "${text.slice(0, 120)}"`);
      } catch (err: any) {
        console.error("[discord-bot] !outcome error:", err?.message);
        await message.reply("❌ Error recording outcome.");
      }
      return;
    }

    // !backtest — summary of all board sessions + outcomes for this user
    if (/^!backtest\b/i.test(content)) {
      try {
        const totalRes = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM board_sessions WHERE user_id = $1`, [userId]
        );
        const withOutcomeRes = await pool.query<{ count: string }>(
          `SELECT COUNT(DISTINCT bs.id) AS count
           FROM board_sessions bs
           JOIN board_outcomes bo ON bo.session_id = bs.id
           WHERE bs.user_id = $1`, [userId]
        );
        const detailRes = await pool.query<{
          topic: string;
          proposed_action: string | null;
          created_at: Date;
          outcome_text: string | null;
          check_in_days: number | null;
        }>(
          `SELECT bs.topic, bs.proposed_action, bs.created_at,
                  bo.outcome_text, bo.check_in_days
           FROM board_sessions bs
           LEFT JOIN board_outcomes bo ON bo.session_id = bs.id
           WHERE bs.user_id = $1
           ORDER BY bs.created_at DESC
           LIMIT 20`,
          [userId]
        );
        const total = parseInt(totalRes.rows[0]?.count ?? "0", 10);
        const withOutcome = parseInt(withOutcomeRes.rows[0]?.count ?? "0", 10);
        const lines = detailRes.rows.map(r => {
          const when = new Date(r.created_at).toLocaleDateString();
          const outcome = r.outcome_text ? `→ Outcome (${r.check_in_days}d): ${r.outcome_text.slice(0, 120)}` : "→ No outcome recorded yet";
          return `• ${when} — ${r.topic.slice(0, 100)}\n  Action: ${r.proposed_action?.slice(0, 100) ?? "none"}\n  ${outcome}`;
        });
        const summary = [
          `**Board Backtest**`,
          `Total sessions: **${total}** | With outcomes: **${withOutcome}**`,
          ``,
          ...lines,
        ].join("\n");
        const preview = summary.length > 1900 ? summary.slice(0, 1900) + "…" : summary;
        await message.reply(preview);
      } catch (err: any) {
        console.error("[discord-bot] !backtest error:", err?.message);
        await message.reply("❌ Error fetching backtest data.");
      }
      return;
    }

    // --- Decision Inbox commands ---

    // !queue: [topic] or !add to board: [topic]
    const queueMatch = content.match(/^(?:!queue|!add to board)[:\s]+(.+)/is);
    if (queueMatch) {
      const topic = queueMatch[1].trim();
      try {
        const id = await addToInbox(message.channelId, userId, topic);
        await message.reply(`✅ Added to board inbox (\`${id.slice(0, 8)}\`): "${topic.slice(0, 100)}"`);
      } catch (err: any) {
        console.error("[discord-bot] !queue error:", err?.message);
        await message.reply("❌ Error adding to inbox.");
      }
      return;
    }

    // !inbox — list queued items
    if (/^!inbox\b/i.test(content)) {
      try {
        const items = await getUserInbox(userId);
        if (items.length === 0) {
          await message.reply("Your board inbox is empty. Use `!queue: [topic]` to add items.");
          return;
        }
        const lines = items.map((item, i) => {
          const when = new Date(item.created_at).toLocaleDateString();
          return `**${i + 1}.** \`${item.id.slice(0, 8)}\` [${item.status}] (${when}) — ${item.topic.slice(0, 150)}`;
        });
        await message.reply(`**Board inbox (${items.length} items):**\n${lines.join("\n")}\n\nRun \`!board-inbox [n]\` to send item to the board, or \`!close [n]\` to remove.`);
      } catch (err: any) {
        console.error("[discord-bot] !inbox error:", err?.message);
        await message.reply("❌ Error fetching inbox.");
      }
      return;
    }

    // !board-inbox [n] — run item n from inbox through the board
    const boardInboxMatch = content.match(/^!board-inbox\s+(\d+)/i);
    if (boardInboxMatch) {
      const n = parseInt(boardInboxMatch[1], 10);
      try {
        const items = await getUserInbox(userId);
        if (n < 1 || n > items.length) {
          await message.reply(`❌ Item ${n} not found. You have ${items.length} item(s) in your inbox.`);
          return;
        }
        const item = items[n - 1];
        // Mark as in-board
        await pool.query(
          `UPDATE board_inbox SET status = 'in-board', updated_at = now() WHERE id = $1`,
          [item.id]
        );
        // Queue the board task
        const hint = CONTEXT_HINTS.find(h => h.pattern.test(item.topic));
        const taskId = await queueTask(userId, "auto", "board", {
          prompt: item.topic,
          discord_channel_id: message.channelId,
          _roster_ctx: ctx,
          _inbox_id: item.id,
          ...(hint ? { context: hint.context } : {}),
        });
        await message.react("⚡");
        await message.reply(`🗳️ Sending inbox item ${n} to the board: "${item.topic.slice(0, 100)}" (task \`${taskId.slice(0, 8)}\`)`);
      } catch (err: any) {
        console.error("[discord-bot] !board-inbox error:", err?.message);
        await message.reply("❌ Error starting board session from inbox.");
      }
      return;
    }

    // !close [n] — close inbox item n
    const closeMatch = content.match(/^!close\s+(\d+)/i);
    if (closeMatch) {
      const n = parseInt(closeMatch[1], 10);
      try {
        const items = await getUserInbox(userId);
        if (n < 1 || n > items.length) {
          await message.reply(`❌ Item ${n} not found. You have ${items.length} item(s) in your inbox.`);
          return;
        }
        const item = items[n - 1];
        await pool.query(
          `UPDATE board_inbox SET status = 'closed', updated_at = now() WHERE id = $1`,
          [item.id]
        );
        await message.reply(`✅ Closed inbox item ${n}: "${item.topic.slice(0, 100)}"`);
      } catch (err: any) {
        console.error("[discord-bot] !close error:", err?.message);
        await message.reply("❌ Error closing inbox item.");
      }
      return;
    }

    // Natural language inbox detection
    const nlInboxTopic = extractInboxTopic(content);
    if (nlInboxTopic) {
      try {
        const id = await addToInbox(message.channelId, userId, nlInboxTopic);
        await message.reply(`✅ Added to board inbox (\`${id.slice(0, 8)}\`): "${nlInboxTopic.slice(0, 100)}"`);
      } catch (err: any) {
        console.error("[discord-bot] nl inbox error:", err?.message);
        await message.reply("❌ Error adding to inbox.");
      }
      return;
    }

    // Standard task routing
    const { to_agent: rawAgent, type, prompt, extra } = parseCommand(content);
    const from = userId;

    // Guard: unknown agent prefix (e.g. !gpt99:) — warn and fall through to Claude
    if (rawAgent === "_unknown_") {
      const unknownName = (extra?._unknown_agent as string) ?? "that agent";
      await message.reply(`⚠️ Unknown agent "**${unknownName}**" — routing to Claude instead. Available: \`!beast:\`, \`!claude:\`, \`!gemini:\`, \`!codex:\``);
      // Re-parse without the unknown prefix and route as plain chat
      const strippedContent = content.replace(/^!\w+:\s*/, "");
      const reparsed = parseCommand(strippedContent || prompt);
      Object.assign({ to_agent: reparsed.to_agent }, { rawAgent: reparsed.to_agent });
    }

    // Guard: empty prompt after parsing (e.g. "!beast:" with no body)
    if (!prompt.trim() || prompt === "__empty__") {
      await message.reply("What would you like me to do? (your message had no content after the command)");
      return;
    }

    // Guard: single ambiguous word with no context ("why", "how", "explain", "what")
    const singleWordAmbiguous = /^(why|how|what|explain|help|ok|yes|no|sure|thanks|huh|hmm)\??\.?$/i.test(prompt.trim());
    if (type === "chat" && singleWordAmbiguous) {
      await message.reply(`Got "**${prompt.trim()}**" — can you give me a bit more context? What would you like me to help with?`);
      return;
    }

    // Guard: board/debate with empty topic
    if ((type === "board" || type === "board_plan" || type === "debate") && !prompt.trim()) {
      await message.reply(`❌ \`!${type}:\` requires a topic. Example: \`!board: should we expand to APAC?\``);
      return;
    }

    // Fetch truncation warning early — needed for both cache hit and normal reply paths.
    const truncationWarning = await getConversationTruncationWarning(message.channelId, message.author.id, 8);

    // Check prompt cache — skip queue if same prompt answered recently in this channel
    if (type === "chat") {
      const cached = getCachedResponse(message.channelId, prompt);
      if (cached) {
        console.log(`[discord-bot] cache hit for channel ${message.channelId}`);
        const prefix = truncationWarning ? truncationWarning + "\n" : "";
        await message.reply((prefix + "*(cached)* " + cached).slice(0, 1990));
        return;
      }
    }

    // Apply per-channel model_override — enforces Claude-only channels etc.
    const channelOverride = getChannelModelOverride(message.channelId);
    const to_agent = channelOverride && type === "chat" ? channelOverride : rawAgent;
    if (channelOverride && channelOverride !== rawAgent && type === "chat") {
      console.log(`[discord-bot] model_override for channel ${message.channelId}: ${rawAgent} → ${channelOverride}`);
    }

    if (type === "chat" && isAmbiguousMessage(content)) {
      await message.reply(clarificationPrompt(content));
      return;
    }

    let promptWithContext = prompt;

    // Inject web context for !search: commands, URLs, or questions that need live data
    const urlMatch = content.match(/https?:\/\/\S+/);
    const autoSearch = !extra?.web_search && !urlMatch && needsWebSearch(content);
    if (extra?.web_search || autoSearch || urlMatch) {
      let webCtx = "";
      if (urlMatch) {
        webCtx = await fetchUrlContent(urlMatch[0]);
      } else {
        webCtx = await fetchWebContext(prompt);
      }
      if (webCtx) {
        const source = urlMatch
          ? `Content retrieved from ${urlMatch[0]}`
          : "Web search results";
        promptWithContext = `[${source} — read this and answer the user's question using it]\n\n${webCtx}\n\nUser question: ${prompt}`;
      } else if (urlMatch) {
        // Fetch failed — tell the model explicitly so it doesn't hallucinate page content
        promptWithContext = `[Note: attempted to retrieve ${urlMatch[0]} but got no content — tell the user the page couldn't be fetched.]\n\nUser question: ${prompt}`;
      }
    }

    if (classifyDiscordIntent(content) === "repair") {
      // Add repair framing — coordinator will inject history/lessons on top of this
      promptWithContext = [
        "The user is issuing a repair command.",
        "Do not ask for clarification unless absolutely necessary.",
        "Use the recent failure chain, conversation history, and lessons to identify the likely broken path.",
        "Respond with the concrete fix or the smallest repair plan, then the next action.",
        `User message: ${promptWithContext}`,
      ].join("\n");
    }

    try {
      const taskId = await queueTask(from, to_agent, type, {
        prompt: promptWithContext,
        ...extra,
        discord_channel_id: message.channelId,
        discord_user_id:    message.author.id,
        discord_username:   message.author.displayName ?? message.author.username,
        _roster_ctx:        ctx,
      });
      const isCodex = to_agent === "codex";
      await message.react(isCodex ? "⏳" : "⚡");
      console.log(`[discord-bot] queued task ${taskId.slice(0, 8)} from ${from} → ${to_agent}`);
      if (type !== "debate") {
        void waitAndReply(client, message, taskId, truncationWarning, prompt);
      }
    } catch (err: any) {
      console.error("[discord-bot] error queuing task:", err?.message);
      await message.reply("⚠️ Couldn't queue that task. Please try again.").catch(() => {});
    }
  }); }

  connect(client).catch(err => {
    console.error("[discord-bot] login failed:", err?.message);
  });
}
