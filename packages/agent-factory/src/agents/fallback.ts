import type { AgentTask } from "../coordinator.js";

type Executor = (task: AgentTask) => Promise<string>;

// Wraps an executor with a Claude fallback. If the primary throws (Beast down,
// network error, empty response), retries once on Claude and logs the fallback.
export async function withFallback(
  primary: Executor,
  fallbackName: string,
  task: AgentTask,
): Promise<string> {
  try {
    return await primary(task);
  } catch (err: any) {
    const primaryMsg = err?.message?.slice(0, 120) ?? String(err);
    console.warn(`[agent] primary executor failed (${primaryMsg}), falling back to ${fallbackName}`);

    // Try the named fallback first, then a local Beast/local chain, and only
    // then Claude CLI again as the very last resort.
    try {
      if (fallbackName === "claude") {
        const { execute } = await import("./claude-cli.js");
        return await execute(task);
      }
      if (fallbackName === "beast") {
        const { execute } = await import("./beast.js");
        return await execute(task);
      }
      if (fallbackName === "local") {
        const { execute } = await import("./local.js");
        return await execute(task);
      }
    } catch (fallbackErr: any) {
      console.warn(`[agent] fallback ${fallbackName} failed (${fallbackErr?.message?.slice(0, 120) ?? String(fallbackErr)})`);
    }

    try {
      const beastHealth = process.env.BEAST_HEALTH_URL ?? (process.env.BEAST_URL ? `${process.env.BEAST_URL}/health` : "");
      if (beastHealth) {
        const { execute } = await import("./beast.js");
        return await execute(task);
      }
    } catch {}

    try {
      const { execute } = await import("./local.js");
      return await execute(task);
    } catch {}

    const { execute } = await import("./claude-cli.js");
    return execute(task);
  }
}
