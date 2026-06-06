CREATE TABLE IF NOT EXISTS agent_tasks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent    TEXT        NOT NULL,
  to_agent      TEXT        NOT NULL DEFAULT 'auto',
  type          TEXT        NOT NULL DEFAULT 'chat',
  payload       JSONB       NOT NULL DEFAULT '{}',
  priority      INTEGER     NOT NULL DEFAULT 3,
  status        TEXT        NOT NULL DEFAULT 'pending',
  result        TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_tasks_status_priority_idx
  ON agent_tasks (status, priority ASC, created_at ASC);
