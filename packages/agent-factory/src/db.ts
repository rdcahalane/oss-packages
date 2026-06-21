import pg from "pg";
import { PgBoss } from "pg-boss";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ override: true });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initDb(): Promise<void> {
  try {
    const sql = await readFile(path.join(__dirname, "migrations", "board-memory.sql"), "utf8");
    await pool.query(sql);
    console.log("[db] board-memory migrations applied");
  } catch (err: any) {
    console.error("[db] migration error:", err?.message);
  }
}

// Singleton pg-boss instance — manages its own pgboss.* schema tables
let _boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (_boss) return _boss;
  _boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
  });
  await _boss.start();
  // pg-boss v12+ requires explicit queue creation before send() or work()
  await _boss.createQueue("agent-tasks");
  console.log("[db] pg-boss started");
  return _boss;
}

export default pool;
