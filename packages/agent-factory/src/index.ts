import dotenv from "dotenv";
dotenv.config({ override: true });

import pg from "pg";
import { initDb } from "./db.js";
import { startCoordinator } from "./coordinator.js";
import { startDiscordBot } from "./discord-bot.js";
import { startFileBot } from "./file-bot.js";

// ---------------------------------------------------------------------------
// Singleton lock — prevents two coordinator instances from running at once.
//
// IMPORTANT: uses a DEDICATED pg.Client (not the shared pool) so the
// connection stays open indefinitely. Pool connections can be closed by the
// pool manager after idleTimeoutMillis (30s), which would release the lock.
// A dedicated client is never closed by the pool, so the lock persists for
// the lifetime of this process.
//
// Lock key 0x6167 = "ag" (agent-factory namespace).
// ---------------------------------------------------------------------------
const ADVISORY_LOCK = 0x6167;
const lockClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
await lockClient.connect();
const lockRes = await lockClient.query("SELECT pg_try_advisory_lock($1)", [ADVISORY_LOCK]);
if (!lockRes.rows[0].pg_try_advisory_lock) {
  console.error(
    "[startup] ⛔ Another agent-factory instance already holds the advisory lock. " +
    "Exiting so only one coordinator runs at a time.",
  );
  await lockClient.end();
  process.exit(0); // exit 0 so tsx watch doesn't rapid-restart
}
// Keep lockClient open — closing it would release the advisory lock.
// It is intentionally leaked; the OS will close it when the process exits.
console.log("[startup] ✅ Singleton lock acquired (pg_advisory_lock 0x6167, dedicated client)");

// Run DB migrations before starting services
await initDb();

// ---------------------------------------------------------------------------
// Startup validation — log which agents/services are available vs degraded
// ---------------------------------------------------------------------------
(async () => {
  const checks: Array<{ name: string; ok: boolean; note?: string }> = [];

  // API key checks
  checks.push({ name: "ANTHROPIC_API_KEY", ok: !!process.env.ANTHROPIC_API_KEY, note: process.env.ANTHROPIC_API_KEY ? undefined : "claude tasks will fall back to Beast" });
  checks.push({ name: "DISCORD_BOT_TOKEN", ok: !!process.env.DISCORD_BOT_TOKEN, note: process.env.DISCORD_BOT_TOKEN ? undefined : "Discord transport disabled" });
  checks.push({ name: "AGENT_ROUTER_ENABLED", ok: process.env.AGENT_ROUTER_ENABLED === "1", note: process.env.AGENT_ROUTER_ENABLED === "1" ? undefined : "coordinator worker not started" });

  // Beast reachability
  try {
    const beastBase = process.env.BEAST_URL ?? "http://localhost:8081";
    const beastHealthUrl = process.env.BEAST_HEALTH_URL ?? `${beastBase.replace(/\/$/, "")}/health`;
    const beastRes = await fetch(beastHealthUrl, { signal: AbortSignal.timeout(3_000) });
    checks.push({ name: "Beast inference", ok: beastRes.ok });
  } catch {
    checks.push({ name: "Beast inference", ok: false, note: "fallback unavailable" });
  }

  // OpenBrain reachability
  try {
    const obRes = await fetch("http://localhost:3210/api/health", { signal: AbortSignal.timeout(3_000) });
    checks.push({ name: "OpenBrain", ok: obRes.ok });
  } catch {
    checks.push({ name: "OpenBrain", ok: false, note: "iMessage alerts disabled" });
  }

  const lines = checks.map(c => `  ${c.ok ? "✅" : "⚠️ "} ${c.name}${c.note ? ` — ${c.note}` : ""}`).join("\n");
  const allOk = checks.every(c => c.ok);
  console.log(`[startup] Service validation (${allOk ? "all systems go" : "some degraded"}):\n${lines}`);
})().catch(() => {/* non-fatal */});

// TRANSPORT=discord (default) | file | both
const transport = (process.env.TRANSPORT ?? "discord").toLowerCase();

if (transport === "discord" || transport === "both") startDiscordBot();
if (transport === "file"    || transport === "both") startFileBot();

await startCoordinator();
