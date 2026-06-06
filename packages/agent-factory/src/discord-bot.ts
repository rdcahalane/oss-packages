import {
  Client, GatewayIntentBits, Message, Events,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder,
} from "discord.js";
import pool from "./db.js";
import { notifyQueued } from "./discord.js";
import { extractProposedAction } from "./debate.js";

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

type Sendable = { send: (content: any) => Promise<any> };

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

export async function postDebateAction(
  taskId: string,
  proposedAction: string,
  topic: string,
  channelId?: string,
): Promise<void> {
  const ch = channelId ?? ALLOWED_CHANNEL;
  if (!botClient || !ch) return;

  const channel = botClient.channels.cache.get(ch) as (Sendable | null) | undefined;
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle("🗳️ Debate Verdict — Proposed Action")
    .addFields(
      { name: "Topic", value: topic.slice(0, 200) },
      { name: "Proposed Action", value: proposedAction.slice(0, 500) },
      { name: "Task", value: `\`${taskId.slice(0, 8)}\``, inline: true },
    )
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
  const res = await pool.query<{ id: string }>(`
    INSERT INTO agent_tasks (from_agent, to_agent, type, payload, priority)
    VALUES ($1, $2, $3, $4, 3)
    RETURNING id
  `, [from, to_agent, type, JSON.stringify(payload)]);
  return res.rows[0].id;
}

// !debate [agentA vs agentB [N]] [--red agentName]: topic
// !beast: / !local: / !gemini: / !claude: / !codex: prompt
// anything else → auto-route as chat
function parseCommand(content: string): { to_agent: string; type: string; prompt: string; extra?: Record<string, any> } {
  const debateMatch = content.match(/^!debate(?:\s+([\w]+(?:\s+vs\s+[\w]+)+)(?:\s+(\d+))?(?:\s+--red\s+([\w]+))?)?:\s*([\s\S]+)/i);
  if (debateMatch) {
    const agents = debateMatch[1]
      ? debateMatch[1].toLowerCase().split(/\s+vs\s+/).map(s => s.trim())
      : ["claude", "local"];
    const rounds   = debateMatch[2] ? parseInt(debateMatch[2], 10) : undefined;
    const red_team = debateMatch[3]?.toLowerCase() ?? undefined;
    const topic    = debateMatch[4].trim();
    const hint     = CONTEXT_HINTS.find(h => h.pattern.test(topic));
    return {
      to_agent: "auto",
      type: "debate",
      prompt: topic,
      extra: { agents, ...(rounds ? { rounds } : {}), ...(red_team ? { red_team } : {}), ...(hint ? { context: hint.context } : {}) },
    };
  }

  const agentMatch = content.match(/^!(beast|gemini|local|claude|codex|openai):\s*([\s\S]+)/i);
  if (agentMatch) {
    return { to_agent: agentMatch[1].toLowerCase(), type: "chat", prompt: agentMatch[2].trim() };
  }

  return { to_agent: "auto", type: "chat", prompt: content.trim() };
}

async function waitAndReply(client: Client, message: Message, taskId: string): Promise<void> {
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
      await message.reply(`✅ ${preview}`);
      return;
    }
    if (row.status === "failed") {
      await message.reply(`❌ \`${row.error?.slice(0, 300) ?? "unknown error"}\``);
      return;
    }
  }
  await message.reply("⏱️ Task timed out.");
}

export function startDiscordBot(): void {
  if (!BOT_TOKEN) {
    console.log("[discord-bot] DISCORD_BOT_TOKEN not set — bot disabled");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, () => {
    botClient = client;
    console.log(`[discord-bot] logged in as ${client.user?.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
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
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!message.content.trim()) return;
    if (ALLOWED_CHANNEL && message.channelId !== ALLOWED_CHANNEL) return;

    const { to_agent, type, prompt, extra } = parseCommand(message.content);
    const from = `discord:${message.author.username}`;

    try {
      const taskId = await queueTask(from, to_agent, type, { prompt, ...extra, discord_channel_id: message.channelId });
      const isCodex = to_agent === "codex";
      await message.react(isCodex ? "⏳" : "⚡");
      console.log(`[discord-bot] queued task ${taskId.slice(0, 8)} from ${from} → ${to_agent}`);
      if (isCodex) {
        const fakeTask = { id: taskId, from_agent: from, to_agent, type, payload: { prompt }, status: "pending" } as any;
        void notifyQueued(fakeTask);
      } else if (type !== "debate") {
        void waitAndReply(client, message, taskId);
      }
    } catch (err: any) {
      console.error("[discord-bot] error queuing task:", err?.message);
      await message.react("❌");
    }
  });

  client.login(BOT_TOKEN).catch(err => {
    console.error("[discord-bot] login failed:", err?.message);
  });
}
