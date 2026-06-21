// File-based transport — alternative to Discord for friends who don't want a bot.
//
// Usage:
//   1. Set TRANSPORT=file (or TRANSPORT=both) in .env
//   2. Set CONVERSATION_DIR=~/my-agent-chats (default: ./conversation)
//   3. npm start
//   4. Open inbox.md in any editor, type a message, save.
//   5. Watch conversation.md grow with responses.
//
// Inbox clears automatically after pickup — blank inbox = ready for next message.
// Open conversation.md in VS Code (Cmd+Shift+V), Obsidian, or: tail -f conversation.md

import { watch, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import pool from "./db.js";
import { extractProposedAction } from "./debate.js";
import { notifyQueued } from "./discord.js";
import { buildIntentPrompt, classifyDiscordIntent } from "./discord-intents.js";
import { kickAdvisor, inviteAdvisor, getRosterText } from "./roster.js";
import { HELP_TEXT } from "./help.js";

const RAW_DIR = process.env.CONVERSATION_DIR ?? "./conversation";
const CONVERSATION_DIR = RAW_DIR.startsWith("~")
  ? join(homedir(), RAW_DIR.slice(1))
  : resolve(RAW_DIR);

const INBOX_FILE = join(CONVERSATION_DIR, "inbox.md");
const CONV_FILE  = join(CONVERSATION_DIR, "conversation.md");

// Track last proposed action so !approve/!reject work
let lastProposedAction: { taskId: string; action: string } | null = null;

// ── File helpers ──────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function appendToConversation(speaker: string, content: string, extra = ""): void {
  const header = extra
    ? `\n**${speaker}** ${extra} · ${ts()}\n`
    : `\n**${speaker}** · ${ts()}\n`;
  appendFileSync(CONV_FILE, `${header}${content.trim()}\n`);
}

function appendDivider(): void {
  appendFileSync(CONV_FILE, "\n---\n");
}

// ── Task queue helpers ────────────────────────────────────────────────────────

async function queueTask(type: string, to_agent: string, payload: Record<string, any>): Promise<string> {
  const res = await pool.query<{ id: string }>(`
    INSERT INTO agent_tasks (from_agent, to_agent, type, payload, priority)
    VALUES ('file-bot', $1, $2, $3, 3)
    RETURNING id
  `, [to_agent, type, JSON.stringify(payload)]);
  return res.rows[0].id;
}

async function pollTask(taskId: string): Promise<{ status: string; result?: string; error?: string }> {
  const maxWait = 300_000;
  const interval = 3_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    const res = await pool.query<{ status: string; result: string; error: string }>(
      `SELECT status, result, error FROM agent_tasks WHERE id = $1`, [taskId]
    );
    const row = res.rows[0];
    if (!row) return { status: "missing" };
    if (row.status === "done" || row.status === "failed") return row;
  }
  return { status: "timeout" };
}

// ── Command parser (same syntax as Discord bot) ───────────────────────────────

interface ParsedCommand {
  to_agent: string;
  type: string;
  prompt: string;
  extra?: Record<string, any>;
}

function parseCommand(text: string): ParsedCommand | null {
  const content = text.trim();
  if (!content) return null;

  // !help
  if (/^!help\b/i.test(content)) return { to_agent: "__help__", type: "__help__", prompt: content };

  // !approve / !reject / !ask — respond to last debate proposed action
  if (/^!approve\b/i.test(content)) return { to_agent: "__approve__", type: "__approve__", prompt: content };
  if (/^!reject\b/i.test(content))  return { to_agent: "__reject__",  type: "__reject__",  prompt: content };
  if (/^!ask\b/i.test(content))     return { to_agent: "__ask__",     type: "__ask__",     prompt: content };

  // Roster management
  if (/^!roster\b/i.test(content))  return { to_agent: "__roster__",  type: "__roster__",  prompt: content };
  const kickMatch   = content.match(/^!kick\s+([\w]+)/i);
  if (kickMatch)  return { to_agent: "__kick__",   type: "__kick__",   prompt: kickMatch[1] };
  const inviteMatch = content.match(/^!invite\s+([\w]+)/i);
  if (inviteMatch) return { to_agent: "__invite__", type: "__invite__", prompt: inviteMatch[1] };

  // !board [cfo cmo ...]: topic
  const boardMatch = content.match(/^!board(?:\s+([\w\s]+?))?:\s*([\s\S]+)/i);
  if (boardMatch) {
    const rawIds = boardMatch[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    const topic  = boardMatch[2].trim();
    return {
      to_agent: "auto", type: "board", prompt: topic,
      extra: { ...(rawIds.length ? { advisor_ids: rawIds } : {}) },
    };
  }

  // !debate [agentA vs agentB [N]] [--red agentName] [--socratic agentName]: topic
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
    return {
      to_agent: "auto", type: "debate", prompt: topic,
      extra: {
        agents,
        ...(rounds   ? { rounds }   : {}),
        ...(red_team ? { red_team } : {}),
        ...(socratic ? { socratic } : {}),
      },
    };
  }

  // !agentname: prompt
  const agentMatch = content.match(/^!(beast|gemini|local|claude|codex|openai):\s*([\s\S]+)/i);
  if (agentMatch) return { to_agent: agentMatch[1].toLowerCase(), type: "chat", prompt: agentMatch[2].trim() };

  const intent = classifyDiscordIntent(content);
  if (intent === "board" || intent === "debate") {
    return { to_agent: "auto", type: intent, prompt: content };
  }

  // plain text → chat
  return { to_agent: "auto", type: "chat", prompt: buildIntentPrompt(content) };
}

// ── Debate streaming handler ──────────────────────────────────────────────────

async function runDebateFromFile(taskId: string, topic: string): Promise<void> {
  // Poll DB for debate rounds as they're written — coordinator writes to agent_tasks.result
  // We watch for completed debate by polling status, then parse the formatted transcript
  appendToConversation("⚙️ system", `Debate started — agents responding...\n*(open conversation.md to follow along)*`);

  const result = await pollTask(taskId);

  if (result.status === "timeout") {
    appendToConversation("⚙️ system", "Debate timed out (>5 min).");
    appendDivider();
    return;
  }
  if (result.status === "failed") {
    appendToConversation("⚙️ system", `Debate failed: ${result.error?.slice(0, 300)}`);
    appendDivider();
    return;
  }

  // Write the full transcript (already formatted by debate.ts)
  appendFileSync(CONV_FILE, `\n${result.result!.trim()}\n`);

  // Extract proposed action and offer approve/reject
  const proposed = extractProposedAction(result.result ?? "");
  if (proposed) {
    lastProposedAction = { taskId, action: proposed };
    appendFileSync(CONV_FILE,
      `\n> **PROPOSED ACTION:** ${proposed}\n` +
      `> *Reply \`!approve\` to execute · \`!reject\` to dismiss · \`!ask\` to probe further*\n`
    );
  }

  appendDivider();
}

// ── Handle approve/reject/ask ─────────────────────────────────────────────────

async function handleApprove(): Promise<void> {
  if (!lastProposedAction) {
    appendToConversation("⚙️ system", "No pending proposed action to approve.");
    return;
  }
  const { action } = lastProposedAction;
  lastProposedAction = null;

  appendToConversation("✅ approved", `Executing: *${action}*`);
  const execId = await queueTask("chat", "auto", { prompt: `Execute this approved action: ${action}` });
  const result = await pollTask(execId);

  if (result.status === "done") {
    appendToConversation("claude", result.result ?? "");
  } else {
    appendToConversation("⚙️ system", `Execution failed: ${result.error ?? result.status}`);
  }
  appendDivider();
}

async function handleReject(): Promise<void> {
  lastProposedAction = null;
  appendToConversation("❌ rejected", "No action taken.");
  appendDivider();
}

async function handleAsk(extraPrompt: string): Promise<void> {
  if (!lastProposedAction) {
    appendToConversation("⚙️ system", "No pending debate context to ask about.");
    return;
  }
  const { taskId } = lastProposedAction;
  const res = await pool.query<{ result: string }>(`SELECT result FROM agent_tasks WHERE id = $1`, [taskId]);
  const synthesis = res.rows[0]?.result ?? "";
  const followup = extraPrompt.replace(/^!ask\s*/i, "").trim() ||
    "What are the key open questions, risks, and follow-up considerations?";

  const askId = await queueTask("chat", "claude", {
    prompt: `${followup}\n\nDebate context:\n${synthesis.slice(0, 1500)}`
  });
  const result = await pollTask(askId);
  if (result.status === "done") appendToConversation("claude", result.result ?? "");
  else appendToConversation("⚙️ system", `Ask failed: ${result.error ?? result.status}`);
  appendDivider();
}

// ── Roster management ────────────────────────────────────────────────────────

function handleKick(id: string): void {
  appendToConversation("⚙️ roster", kickAdvisor(id, "file"));
  appendDivider();
}

function handleInvite(id: string): void {
  appendToConversation("⚙️ roster", inviteAdvisor(id, "file"));
  appendDivider();
}

function handleRoster(): void {
  appendToConversation("⚙️ roster", getRosterText("file"));
  appendDivider();
}

// ── Main inbox processor ──────────────────────────────────────────────────────

async function processInbox(): Promise<void> {
  let raw = "";
  try {
    raw = readFileSync(INBOX_FILE, "utf8").trim();
  } catch {
    return; // file doesn't exist yet or read error
  }
  if (!raw) return;

  // Clear inbox immediately so user knows it was picked up
  writeFileSync(INBOX_FILE, "");

  const cmd = parseCommand(raw);
  if (!cmd) return;

  appendDivider();
  appendToConversation("You", raw);

  if (cmd.type === "__help__")    { appendToConversation("⚙️ help", HELP_TEXT); appendDivider(); return; }
  if (cmd.type === "__approve__") { await handleApprove(); return; }
  if (cmd.type === "__reject__")  { await handleReject();  return; }
  if (cmd.type === "__ask__")     { await handleAsk(raw);  return; }
  if (cmd.type === "__roster__")  { handleRoster();  return; }
  if (cmd.type === "__kick__")    { handleKick(cmd.prompt);   return; }
  if (cmd.type === "__invite__")  { handleInvite(cmd.prompt); return; }

  if (cmd.type === "debate") {
    const taskId = await queueTask("debate", "auto", {
      prompt: cmd.prompt, ...(cmd.extra ?? {}),
    });
    await runDebateFromFile(taskId, cmd.prompt);
    return;
  }

  if (cmd.to_agent === "codex") {
    const taskId = await queueTask("chat", "codex", { prompt: cmd.prompt });
    const fakeTask = { id: taskId, from_agent: "file-bot", to_agent: "codex",
      type: "chat", payload: { prompt: cmd.prompt }, status: "pending" } as any;
    void notifyQueued(fakeTask);
    appendToConversation("⚙️ system", `Codex task queued (\`${taskId.slice(0, 8)}\`) — waiting for a Codex session to claim it.`);
    appendDivider();
    return;
  }

  // Standard chat task — poll and write result
  const taskId = await queueTask(cmd.type, cmd.to_agent, { prompt: cmd.prompt });
  const result = await pollTask(taskId);

  if (result.status === "done") {
    const agentRes = await pool.query<{ to_agent: string }>(
      `SELECT to_agent FROM agent_tasks WHERE id = $1`, [taskId]
    );
    const agentName = agentRes.rows[0]?.to_agent ?? cmd.to_agent;
    appendToConversation(agentName === "auto" ? "agent" : agentName, result.result ?? "");
  } else {
    appendToConversation("⚙️ system", `Error: ${result.error ?? result.status}`);
  }
  appendDivider();
}

// ── Watch inbox for changes ───────────────────────────────────────────────────

let processing = false;

export function startFileBot(): void {
  // Ensure conversation dir exists
  if (!existsSync(CONVERSATION_DIR)) mkdirSync(CONVERSATION_DIR, { recursive: true });

  // Create inbox.md if missing
  if (!existsSync(INBOX_FILE)) {
    writeFileSync(INBOX_FILE,
      `# Board of Advisor Agents — Inbox\n\n` +
      `Type your message below this line and save the file.\n` +
      `This file clears automatically after pickup.\n\n` +
      `Type !help and save to see all available commands.\n\n` +
      `---\n\n`
    );
  }

  // Create conversation.md if missing
  if (!existsSync(CONV_FILE)) {
    writeFileSync(CONV_FILE,
      `# Agent Factory — Conversation\n\n` +
      `_Messages appear here as agents respond._\n\n` +
      `---\n\n`
    );
  }

  console.log(`[file-bot] watching ${INBOX_FILE}`);
  console.log(`[file-bot] conversation log: ${CONV_FILE}`);

  watch(INBOX_FILE, async () => {
    if (processing) return;
    processing = true;
    try {
      await processInbox();
    } catch (err: any) {
      console.error("[file-bot] error:", err?.message);
    } finally {
      processing = false;
    }
  });
}
