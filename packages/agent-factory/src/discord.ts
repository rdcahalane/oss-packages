import type { AgentTask } from "./coordinator.js";
import type { AgentName } from "./debate.js";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL ?? "";

const AGENT_EMOJI: Record<string, string> = {
  beast: "🐉",
  claude: "🧠",
  gemini: "✨",
  local: "💻",
  canoe: "🛶",
  kimi: "🌙",
  codex: "🤖",
  openai: "🤖",
};

async function post(embeds: object[]): Promise<void> {
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // never crash the coordinator over a notification failure
  }
}

// notifyClaimed removed — intermediate "claimed task" embeds were pure channel
// noise (one full embed per claim, repeated on re-claims). Completion is covered
// by notifyDone/notifyFailed.

export async function notifyDone(task: AgentTask, agentName: string, result: string, elapsedMs: number): Promise<void> {
  const preview = result.slice(0, 200).replace(/\n/g, " ");
  await post([{
    color: 0x22c55e,
    title: `✅ ${AGENT_EMOJI[agentName] ?? "🤖"} ${agentName} → ${task.type} done`,
    description: preview.length < result.length ? `${preview}…` : preview,
    fields: [
      { name: "From", value: task.from_agent, inline: true },
      { name: "Time", value: `${(elapsedMs / 1000).toFixed(1)}s`, inline: true },
      { name: "ID",   value: `\`${task.id.slice(0, 8)}\``, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export async function notifyFailed(task: AgentTask, agentName: string, error: string, elapsedMs: number): Promise<void> {
  await post([{
    color: 0xef4444,
    title: `❌ ${AGENT_EMOJI[agentName] ?? "🤖"} ${agentName} → ${task.type} failed`,
    description: `\`\`\`${error.slice(0, 300)}\`\`\``,
    fields: [
      { name: "From", value: task.from_agent, inline: true },
      { name: "Time", value: `${(elapsedMs / 1000).toFixed(1)}s`, inline: true },
      { name: "ID",   value: `\`${task.id.slice(0, 8)}\``, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export async function notifyQueued(task: AgentTask): Promise<void> {
  await post([{
    color: 0xa855f7,
    title: `⏳ 🖥️ codex task queued — waiting for Codex session to claim`,
    description: task.payload?.prompt?.slice(0, 200) ?? "",
    fields: [
      { name: "From", value: task.from_agent, inline: true },
      { name: "ID",   value: `\`${task.id.slice(0, 8)}\``, inline: true },
    ],
    timestamp: new Date().toISOString(),
  }]);
}

export async function notifyDebateRound(task: AgentTask, agentName: AgentName, roundNum: number, content: string): Promise<void> {
  // Strip markdown heading markers — Discord renders "# "/"## " as huge font,
  // which made positions unreadable. Keep newlines for structure, and show the
  // full round up to ~3800 chars (embed description max is 4096) instead of a
  // 300-char clip that couldn't be expanded.
  const clean = content.replace(/^#{1,6}\s+/gm, "").trim();
  const MAX = 3800;
  const body = clean.length > MAX ? `${clean.slice(0, MAX)}\n\n…(truncated)` : clean;
  await post([{
    color: 0x6366f1,
    title: `${AGENT_EMOJI[agentName] ?? "🤖"} ${agentName} — Round ${roundNum}`,
    description: body,
    fields: [{ name: "Topic ID", value: `\`${task.id.slice(0, 8)}\``, inline: true }],
    timestamp: new Date().toISOString(),
  }]);
}
