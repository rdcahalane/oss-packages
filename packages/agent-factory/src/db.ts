import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ override: true });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

export default pool;
