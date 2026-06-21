import pool, { getBoss } from "./db.js";
import type { Job } from "pg-boss";
import { routeTask } from "./route.js";
import { notifyFailed, notifyDebateRound } from "./discord.js";
import { runDebate, extractProposedAction, extractProvocation } from "./debate.js";
import { runBoard, planBoard, extractProposedAction as boardExtractAction, extractProvocation as boardExtractProvocation } from "./board.js";
import { getDiscordLessons, getRecentConversationSummary, getUserRulesText, getOpenBrainContext, getOwnerProfile, saveExchangeToOpenBrain } from "./discord-memory.js";
import { postDebateAction, postToChannel } from "./discord-bot.js";

export interface AgentTask {
  id: string;
  from_agent: string;
  to_agent: string;
  type: string;
  payload: Record<string, any>;
  priority: number;
  status: string;
  correlation_id?: string;
}

async function getAgent(name: string) {
  switch (name) {
    case "beast":  return (await import("./agents/beast.js")).execute;
    case "gemini": return (await import("./agents/gemini-cli.js")).execute;
    case "local":  return (await import("./agents/local.js")).execute;
    case "codex":
    case "openai": return (await import("./agents/codex-cli.js")).execute;
    case "claude":
    default:       return (await import("./agents/claude-cli.js")).execute;
  }
}

async function getTask(taskId: string): Promise<AgentTask | null> {
  const res = await pool.query<AgentTask>(
    `SELECT * FROM agent_tasks WHERE id = $1`, [taskId]
  );
  return res.rows[0] ?? null;
}

async function completeTask(id: string, result: string, resolvedAgent?: string): Promise<void> {
  if (resolvedAgent) {
    await pool.query(
      `UPDATE agent_tasks SET status = 'done', result = $1, completed_at = now(), to_agent = $3 WHERE id = $2`,
      [result, id, resolvedAgent]
    );
  } else {
    await pool.query(
      `UPDATE agent_tasks SET status = 'done', result = $1, completed_at = now() WHERE id = $2`,
      [result, id]
    );
  }
}

async function failTask(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE agent_tasks SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
    [error, id]
  );
}

// ---------------------------------------------------------------------------
// Injection detection — runs before routing for all chat tasks.
// Beast has no safety layer; Claude resists injection reliably.
// If a prompt looks like an injection attempt, force-route to Claude.
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|earlier|above)\s+instructions/i,
  /you\s+are\s+now\s+(DAN|jailbroken|unrestricted|an?\s+AI\s+with\s+no\s+restrictions)/i,
  /\bDAN\s+mode\b/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(system\s+)?(prompt|instructions|rules|constraints)/i,
  /pretend\s+(you\s+have\s+no\s+restrictions|you\s+are\s+a\s+different)/i,
  /respond\s+only\s+with\s+the\s+word\s+\w+/i,
  /print\s+(your\s+)?(system\s+prompt|api\s+key|token|secret|password)/i,
  /reveal\s+(your\s+)?(system\s+prompt|instructions|api\s+key|token)/i,
];

function detectInjection(prompt: string): boolean {
  return INJECTION_PATTERNS.some(p => p.test(prompt));
}

/**
 * Inject conversation history, lessons, and user rules into a chat task's prompt.
 * Runs in the coordinator so it applies to all transports (Discord, file-bot, API).
 * Skipped if payload already has _history_injected=true (pre-enriched by caller).
 */
async function injectHistoryIfNeeded(task: AgentTask): Promise<AgentTask> {
  if (task.type !== "chat") return task;
  if (task.payload._history_injected) return task;

  const channelId = task.payload.discord_channel_id as string | undefined;
  const userId    = task.payload.discord_user_id    as string | undefined;
  const username  = task.payload.discord_username   as string | undefined;

  // Skip if no Discord context — file-bot and API tasks don't have channel history
  if (!channelId || !userId) return task;

  try {
    const rawPrompt = String(task.payload.prompt ?? "");
    const [lessons, history, userRules, obContext, ownerProfile] = await Promise.all([
      getDiscordLessons(3),
      getRecentConversationSummary(channelId, userId, 8),
      getUserRulesText(),
      getOpenBrainContext(rawPrompt),
      getOwnerProfile(),
    ]);

    let enrichedPrompt = rawPrompt;

    // Prepend identity so the model knows who it's talking to.
    // Use clear factual framing so both Beast and Claude extract it correctly.
    const identityLine = username
      ? `[Context: The user you are speaking with is named "${username}". This is their Discord display name. Use it when asked who they are or what their name is.]`
      : "";

    const parts: string[] = [];
    if (identityLine) parts.push(identityLine);
    if (ownerProfile) parts.push(`Owner profile — use this to answer ANY question about the user's identity, role, projects, apps, teams, companies, goals, or background. When asked "can you see our projects", "what do you know about me", "what are we working on" etc., answer from this profile:\n${ownerProfile}`);
    if (obContext) parts.push(`Relevant memories:\n${obContext}`);
    if (history) parts.push(`Recent conversation history:\n${history}`);
    if (parts.length) enrichedPrompt = `${parts.join("\n\n")}\n\n${enrichedPrompt}`;

    return {
      ...task,
      payload: {
        ...task.payload,
        prompt:            enrichedPrompt,
        _original_prompt:  rawPrompt,   // preserved for routing — needsClaude checks this, not the enriched prompt
        history,
        user_rules:        userRules,
        _history_injected: true,
      },
    };
  } catch (err: any) {
    // Never fail a task over a history injection error
    console.error("[coordinator] history injection error:", err?.message);
    return task;
  }
}

function extractAdvisorsFromResult(result: string): string[] {
  const matches = result.matchAll(/\*\*\[([A-Z0-9 _-]+)\]\*\*/g);
  const names = new Set<string>();
  for (const m of matches) {
    const name = m[1].trim();
    if (name !== "BOARD SYNTHESIS" && name !== "CRITIC") names.add(name.toLowerCase());
  }
  return Array.from(names);
}

async function logBoardSession(
  task: AgentTask,
  result: string,
  proposed: string | null,
  provocation: string | null,
): Promise<void> {
  try {
    const channelId = task.payload.discord_channel_id ?? "";
    const userId    = task.from_agent;
    const topic     = task.payload.prompt ?? "";
    const advisors  = extractAdvisorsFromResult(result);

    await pool.query(
      `INSERT INTO board_sessions
         (channel_id, user_id, topic, synthesis, proposed_action, provocation, advisors_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [channelId, userId, topic, result, proposed, provocation, advisors]
    );
  } catch (err: any) {
    console.error("[coordinator] logBoardSession error:", err?.message);
  }
}

/** Core task handler — runs after pg-boss delivers a job. */
async function processTask(task: AgentTask): Promise<void> {
  // Mark as claimed in agent_tasks for Discord reply polling
  await pool.query(
    `UPDATE agent_tasks SET status = 'claimed', claimed_at = now() WHERE id = $1`,
    [task.id]
  );

  const start = Date.now();

  // board_plan — dry run: show advisor lineup without executing
  if (task.type === "board_plan") {
    console.log(`[router] task ${task.id} (board_plan) — preview for: ${task.payload.prompt}`);
    const topic     = task.payload.prompt ?? "";
    const rawIds    = task.payload.advisor_ids as string[] | undefined;
    const rosterCtx = task.payload._roster_ctx as string | undefined;
    const plan      = planBoard(topic, rawIds, rosterCtx);
    const lines     = plan.advisors.map(a => `• **${a.name}** (\`${a.id}\`) — ${a.domain}`).join("\n");
    const result    = [
      `**Board Plan for:** ${topic}`,
      ``,
      `**Advisors (${plan.advisors.length} selected):**`,
      lines,
      ``,
      `**Estimated time:** ${plan.estimatedTime}`,
      ``,
      `Run \`!board: ${topic}\` to execute this session.`,
    ].join("\n");
    await completeTask(task.id, result);
    return;
  }

  if (task.type === "board") {
    console.log(`[router] task ${task.id} (board) → advisors: ${(task.payload.advisor_ids ?? []).join(", ") || "auto"}`);
    const result = await runBoard(task, (t, advisorId, idx, content) => {
      console.log(`[router] board ${t.id} advisor ${idx} — ${advisorId}`);
      void notifyDebateRound(t, advisorId, idx, content);
    });
    await completeTask(task.id, result);
    const elapsed = Date.now() - start;
    console.log(`[router] board ${task.id} done (${(elapsed / 1000).toFixed(1)}s)`);
    const proposed    = boardExtractAction(result);
    const provocation = boardExtractProvocation(result);
    void logBoardSession(task, result, proposed, provocation);
    if (proposed) {
      void postDebateAction(task.id, proposed, task.payload.prompt ?? "", task.payload.discord_channel_id, provocation);
    }
    return;
  }

  if (task.type === "debate") {
    console.log(`[router] task ${task.id} (debate) → multi-agent`);
    const result = await runDebate(task, (t, agent, round, content) => {
      console.log(`[router] debate ${t.id} round ${round} — ${agent}`);
      void notifyDebateRound(t, agent, round, content);
    });
    await completeTask(task.id, result);
    const elapsed = Date.now() - start;
    console.log(`[router] debate ${task.id} done (${(elapsed / 1000).toFixed(1)}s)`);
    const proposed    = extractProposedAction(result);
    const provocation = extractProvocation(result);
    if (proposed) {
      void postDebateAction(task.id, proposed, task.payload.prompt ?? "", task.payload.discord_channel_id, provocation);
    }
    return;
  }

  // Detect !board plan: prefix in chat tasks — redirect to board_plan handler without LLM.
  // Mirrors discord-bot.ts command parsing for tests and API callers that skip the bot layer.
  {
    const chatPrompt = String(task.payload.prompt ?? "").trim();
    const boardPlanMatch = chatPrompt.match(/^!board\s+plan:\s*(.*)/i);
    if (boardPlanMatch && task.type === "chat") {
      const topic  = boardPlanMatch[1].trim();
      const plan   = planBoard(topic);
      const lines  = plan.advisors.map(a => `• **${a.name}** (\`${a.id}\`) — ${a.domain}`).join("\n");
      const result = [
        `**Board Plan for:** ${topic}`,
        ``,
        `**Advisors (${plan.advisors.length} selected):**`,
        lines,
        ``,
        `**Estimated time:** ${plan.estimatedTime}`,
        ``,
        `Run \`!board: ${topic}\` to execute this session.`,
      ].join("\n");
      await completeTask(task.id, result, "board_plan");
      console.log(`[router] task ${task.id} (board_plan via chat prefix) done`);
      return;
    }
  }

  // Chat — inject history before routing/executing
  const enrichedTask = await injectHistoryIfNeeded(task);

  // Injection guard: Beast has no safety layer — force Claude for suspicious prompts.
  // This runs AFTER history injection so the full enriched prompt is checked.
  const rawPrompt = String(enrichedTask.payload.prompt ?? "");
  let agentName = await routeTask(enrichedTask);
  if (agentName === "beast" && detectInjection(rawPrompt)) {
    console.warn(`[coordinator] injection pattern detected in task ${enrichedTask.id} — overriding beast→claude`);
    agentName = "claude";
  }
  console.log(`[router] task ${task.id} (${task.type}) → ${agentName}`);

  const execute = await getAgent(agentName);
  const result = await execute(enrichedTask);
  await completeTask(task.id, result, agentName);
  console.log(`[router] task ${task.id} done (${result.length} chars, ${((Date.now() - start) / 1000).toFixed(1)}s)`);

  // Durable fact write-back — if the prompt contains self-identifying info, save to OB.
  // Runs in coordinator so it works for all sources (Discord, file, API).
  const originalPrompt = String(task.payload.prompt ?? "");
  const isDurableFact  = /\b(my name is|I('m| am)|I work|my project|my company|my team|I'm building|my goal|my role|codename is|I prefer|I want you to|remember that|for context)\b/i.test(originalPrompt);
  if (isDurableFact) {
    const username = String(task.payload.discord_username ?? task.from_agent ?? "user");
    void saveExchangeToOpenBrain(username, originalPrompt, result, ["coordinator", "user-fact"]).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Health sentinel — tracks last processed job; alerts via iMessage if silent
// ---------------------------------------------------------------------------

let lastProcessedAt = Date.now();
let lastAlertedAt   = 0; // 0 = never alerted

function bumpHealth(): void {
  lastProcessedAt = Date.now();
  lastAlertedAt   = 0; // reset cooldown when a job lands — next stale period gets a fresh alert
}

function startHealthSentinel(): void {
  const STALE_MS   = 60 * 60 * 1000; // 60 min without a processed job = alert
  const COOLDOWN_MS = 4 * 60 * 60 * 1000; // alert at most once every 4 hours
  // Grace period: don't alert for the first 10 min after startup so idle bots don't spam
  const startedAt  = Date.now();

  setInterval(async () => {
    const staleMs = Date.now() - lastProcessedAt;
    if (staleMs < STALE_MS) return;                              // not stale yet
    if (Date.now() - startedAt < 10 * 60 * 1000) return;        // startup grace
    if (Date.now() - lastAlertedAt < COOLDOWN_MS) return;        // already alerted recently

    lastAlertedAt = Date.now();
    const minutes = Math.round(staleMs / 60_000);
    console.error(`[coordinator] HEALTH: no job processed in ${minutes}m — alerting`);
    try {
      await fetch("http://localhost:3210/api/send-imessage", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENBRAIN_API_TOKEN ?? "openbrain-dev-token"}` },
        body: JSON.stringify({ to: process.env.ALERT_PHONE ?? "", message: `⚠️ Agent-Factory coordinator silent for ${minutes}m — check the bot process.` }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {}
  }, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Nightly board health test — runs weekdays at 9 AM ET
// ---------------------------------------------------------------------------

async function scheduleNightlyBoardTest(boss: Awaited<ReturnType<typeof getBoss>>): Promise<void> {
  const QUEUE = "nightly-board-test";
  try {
    await boss.createQueue(QUEUE);
    // Weekdays at 9 AM ET (UTC-4/5 — use 13:00 UTC to cover both EST and EDT)
    await boss.schedule(QUEUE, "0 13 * * 1-5", {});
    await boss.work<Record<string, never>>(QUEUE, async () => {
      console.log("[coordinator] nightly board test — starting");
      const testTask: AgentTask = {
        id:           "nightly-" + Date.now(),
        from_agent:   "coordinator:health",
        to_agent:     "auto",
        type:         "board_plan",
        payload:      { prompt: "health check: should we continue investing in AI automation?" },
        priority:     1,
        status:       "claimed",
      };
      try {
        const topic = testTask.payload.prompt as string;
        const plan  = planBoard(topic);
        const ok    = plan.advisors.length > 0;
        console.log(`[coordinator] nightly board test — ${ok ? "PASS" : "FAIL"} (${plan.advisors.length} advisors)`);
        if (!ok) {
          await fetch("http://localhost:3210/api/send-imessage", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENBRAIN_API_TOKEN ?? "openbrain-dev-token"}` },
            body: JSON.stringify({ to: process.env.ALERT_PHONE ?? "", message: "⚠️ Nightly board health check FAILED — planBoard returned 0 advisors." }),
            signal: AbortSignal.timeout(8_000),
          });
        }
      } catch (err: any) {
        console.error("[coordinator] nightly board test error:", err?.message);
      }
    });
    console.log("[router] nightly board test scheduled (weekdays 9am ET)");
  } catch (err: any) {
    console.warn("[router] nightly board test schedule failed:", err?.message);
  }
}

// ---------------------------------------------------------------------------
// Dead letter: when a job exhausts all retries, notify the user in Discord
// ---------------------------------------------------------------------------

async function notifyDeadLetter(task: AgentTask, error: string): Promise<void> {
  const channelId = task.payload.discord_channel_id as string | undefined;
  if (!channelId) return;

  try {
    await postToChannel(channelId,
      `❌ Task \`${task.id.slice(0, 8)}\` failed after all retries.\n\`\`\`${error.slice(0, 280)}\`\`\``
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Coordinator startup
// ---------------------------------------------------------------------------

export async function startCoordinator(): Promise<void> {
  if (process.env.AGENT_ROUTER_ENABLED !== "1") return;

  const boss = await getBoss();

  // pg-boss v12+ requires the queue to exist before work() can be called
  await boss.createQueue("agent-tasks");
  console.log("[router] coordinator started (pg-boss worker)");

  startHealthSentinel();
  await scheduleNightlyBoardTest(boss);

  await boss.work<{ taskId: string }>(
    "agent-tasks",
    { localConcurrency: 2 },
    async (jobs: Job<{ taskId: string }>[]) => {
      for (const job of jobs) {
        const taskId = job.data.taskId;
        const task = await getTask(taskId);
        if (!task) {
          console.warn(`[router] job ${job.id} — no agent_tasks row for ${taskId}, skipping`);
          return;
        }
        // Codex tasks have their own runner — skip pg-boss, leave as pending
        if (task.to_agent === "codex") {
          await pool.query(
            `UPDATE agent_tasks SET status = 'pending', claimed_at = NULL WHERE id = $1`,
            [taskId]
          );
          return;
        }
        try {
          await processTask(task);
          bumpHealth();
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          await failTask(taskId, msg);
          void notifyFailed(task, task.to_agent !== "auto" ? task.to_agent : "auto", msg, 0);

          // Dead letter: if retries exhausted, notify the user in Discord
          const retryCount   = (job as any).retrycount ?? (job as any).retryCount ?? 0;
          const retryLimit   = (job as any).retrylimit ?? (job as any).retryLimit ?? 3;
          if (retryCount >= retryLimit) {
            console.error(`[router] task ${taskId} exhausted ${retryLimit} retries — dead letter`);
            await notifyDeadLetter(task, msg);
          } else {
            throw err; // re-throw so pg-boss schedules next retry
          }
        }
      }
    }
  );
}
