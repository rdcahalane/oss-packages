import pool from "./db.js";
import { routeTask } from "./route.js";
import { notifyClaimed, notifyDone, notifyFailed, notifyDebateRound } from "./discord.js";
import { runDebate, extractProposedAction } from "./debate.js";
import { postDebateAction } from "./discord-bot.js";

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

async function claimNextTask(): Promise<AgentTask | null> {
  const res = await pool.query<AgentTask>(`
    UPDATE agent_tasks
    SET status = 'claimed', claimed_at = now()
    WHERE id = (
      SELECT id FROM agent_tasks
      WHERE status = 'pending' AND to_agent != 'codex'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return res.rows[0] ?? null;
}

async function completeTask(id: string, result: string): Promise<void> {
  await pool.query(
    `UPDATE agent_tasks SET status = 'done', result = $1, completed_at = now() WHERE id = $2`,
    [result, id]
  );
}

async function failTask(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE agent_tasks SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
    [error, id]
  );
}

async function tick(): Promise<void> {
  const task = await claimNextTask();
  if (!task) return;

  const start = Date.now();

  if (task.type === "debate") {
    console.log(`[router] task ${task.id} (debate) → multi-agent`);
    void notifyClaimed(task, "debate");
    try {
      const result = await runDebate(task, (t, agent, round, content) => {
        console.log(`[router] debate ${t.id} round ${round} — ${agent}`);
        void notifyDebateRound(t, agent, round, content);
      });
      await completeTask(task.id, result);
      const elapsed = Date.now() - start;
      console.log(`[router] debate ${task.id} done (${(elapsed / 1000).toFixed(1)}s)`);
      void notifyDone(task, "debate", result, elapsed);
      const proposed = extractProposedAction(result);
      if (proposed) {
        void postDebateAction(task.id, proposed, task.payload.prompt ?? "", task.payload.discord_channel_id);
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await failTask(task.id, msg);
      void notifyFailed(task, "debate", msg, Date.now() - start);
    }
    return;
  }

  const agentName = await routeTask(task);
  console.log(`[router] task ${task.id} (${task.type}) → ${agentName}`);
  void notifyClaimed(task, agentName);

  try {
    const execute = await getAgent(agentName);
    const result = await execute(task);
    await completeTask(task.id, result);
    const elapsed = Date.now() - start;
    console.log(`[router] task ${task.id} done (${result.length} chars, ${(elapsed / 1000).toFixed(1)}s)`);
    void notifyDone(task, agentName, result, elapsed);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await failTask(task.id, msg);
    void notifyFailed(task, agentName, msg, Date.now() - start);
  }
}

export function startCoordinator(): void {
  if (process.env.AGENT_ROUTER_ENABLED !== "1") return;
  console.log("[router] coordinator started (10s poll)");
  setInterval(() => { tick().catch(e => console.error("[router] tick error:", e)); }, 10_000);
  tick().catch(e => console.error("[router] initial tick error:", e));
}
