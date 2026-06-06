/**
 * hybrid-search-pgvector
 *
 * Hybrid semantic + keyword search over a Postgres + pgvector table.
 * Uses Reciprocal Rank Fusion (RRF) to combine cosine similarity (pgvector)
 * with full-text rank (tsvector GIN) plus a mild recency boost.
 *
 * Requires a Postgres table with this shape:
 *   CREATE TABLE thoughts (
 *     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     content     TEXT NOT NULL,
 *     embedding   vector(768),          -- or your dimension
 *     metadata    JSONB DEFAULT '{}',
 *     tags        TEXT[] DEFAULT '{}',
 *     source      TEXT,
 *     created_at  TIMESTAMPTZ DEFAULT now()
 *   );
 *   CREATE INDEX ON thoughts USING ivfflat (embedding vector_cosine_ops);
 *   CREATE INDEX ON thoughts USING GIN (to_tsvector('english', content));
 *
 * Usage:
 *   import { createHybridSearch } from "hybrid-search-pgvector";
 *
 *   const search = createHybridSearch({
 *     pool,                              // node-postgres Pool
 *     embedFn: text => myEmbed(text),    // any (text) => Promise<number[]>
 *     table: "thoughts",                 // optional, default "thoughts"
 *   });
 *
 *   const results = await search({ query: "project roadmap Q3", limit: 10 });
 */

import type { Pool } from "pg";

export interface HybridSearchConfig {
  /** node-postgres Pool connected to a Postgres + pgvector database */
  pool: Pool;
  /** Function that converts text to an embedding vector */
  embedFn: (text: string) => Promise<number[]>;
  /** Table name — default "thoughts" */
  table?: string;
}

export interface SearchInput {
  query: string;
  limit?: number;
  /** Metadata field filters — all are optional and ANDed together */
  filters?: {
    type?: string;     // metadata->>'type'
    source?: string;   // source column
    tag?: string;      // any(tags)
    person?: string;   // metadata->'people' contains
    topic?: string;    // metadata->'topics' contains
  };
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
  source: string;
  created_at: Date;
  score: number;
}

export interface UpsertInput {
  /** Stable identifier for deduplication (if already exists, skips insert) */
  externalId: string;
  content: string;
  source: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface HybridSearch {
  search(input: SearchInput): Promise<SearchResult[]>;
  upsert(item: UpsertInput): Promise<boolean>;
}

/**
 * Create a search + upsert client backed by the given Postgres pool.
 */
export function createHybridSearch(config: HybridSearchConfig): HybridSearch {
  const table = config.table ?? "thoughts";

  return {
    search: (input) => hybridSearch(config, table, input),
    upsert: (item) => upsertItem(config, table, item),
  };
}

// ── Internal implementation ────────────────────────────────────────────────────

async function hybridSearch(
  config: HybridSearchConfig,
  table: string,
  input: SearchInput,
): Promise<SearchResult[]> {
  const { query, limit = 10, filters = {} } = input;
  const embedding = await config.embedFn(query);
  if (!embedding?.length) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 3; // $1 = vector, $2 = tsquery text, $3+ = filters

  if (filters.type) {
    conditions.push(`metadata->>'type' = $${p++}`);
    params.push(filters.type);
  }
  if (filters.person) {
    conditions.push(`metadata->'people' ? $${p++}`);
    params.push(filters.person);
  }
  if (filters.topic) {
    conditions.push(`metadata->'topics' ? $${p++}`);
    params.push(filters.topic);
  }
  if (filters.source) {
    conditions.push(`source = $${p++}`);
    params.push(filters.source);
  }
  if (filters.tag) {
    conditions.push(`$${p++} = ANY(tags)`);
    params.push(filters.tag);
  }

  const filterSQL = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const limitParam = `$${p}`;

  const sql = `
    WITH semantic AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM ${table}
      WHERE embedding IS NOT NULL
        ${filterSQL}
      LIMIT 40
    ),
    keyword AS (
      SELECT id,
             ROW_NUMBER() OVER (
               ORDER BY ts_rank(to_tsvector('english', content),
                                plainto_tsquery('english', $2)) DESC
             ) AS rank
      FROM ${table}
      WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $2)
        ${filterSQL}
      LIMIT 40
    ),
    rrf AS (
      SELECT
        COALESCE(s.id, k.id) AS id,
        COALESCE(1.0 / (60.0 + s.rank), 0) +
        COALESCE(1.0 / (60.0 + k.rank), 0) AS rrf_score
      FROM semantic s
      FULL OUTER JOIN keyword k ON s.id = k.id
    )
    SELECT
      t.id, t.content, t.metadata, t.tags, t.source, t.created_at,
      r.rrf_score * (0.8 + 0.2 * EXP(
        -EXTRACT(EPOCH FROM (NOW() - t.created_at)) / (90.0 * 86400)
      )) AS score
    FROM rrf r
    JOIN ${table} t ON t.id = r.id
    ORDER BY score DESC
    LIMIT ${limitParam}
  `;

  const result = await config.pool.query(sql, [
    `[${embedding.join(",")}]`,
    query,
    ...params,
  ]);

  return result.rows.map((row) => ({
    id: row.id,
    content: row.content,
    metadata: row.metadata,
    tags: row.tags,
    source: row.source,
    created_at: row.created_at,
    score: parseFloat(row.score),
  }));
}

async function upsertItem(
  config: HybridSearchConfig,
  table: string,
  item: UpsertInput,
): Promise<boolean> {
  const { pool, embedFn } = config;
  const exists = await pool.query(
    `SELECT 1 FROM ${table} WHERE external_id = $1`,
    [item.externalId],
  );
  if (exists.rows.length > 0) return false;

  const embedding = await embedFn(item.content);
  await pool.query(
    `INSERT INTO ${table} (content, embedding, metadata, tags, source, external_id)
     VALUES ($1, $2::vector, $3, $4, $5, $6)`,
    [
      item.content,
      `[${embedding.join(",")}]`,
      JSON.stringify(item.metadata ?? {}),
      item.tags ?? [],
      item.source,
      item.externalId,
    ],
  );
  return true;
}
