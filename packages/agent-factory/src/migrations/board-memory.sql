-- Board session outcome memory and decision inbox
-- Run at startup via initDb() in db.ts

CREATE TABLE IF NOT EXISTS board_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  topic         TEXT        NOT NULL,
  synthesis     TEXT        NOT NULL,
  proposed_action TEXT,
  provocation   TEXT,
  advisors_used TEXT[],
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_outcomes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        REFERENCES board_sessions(id),
  check_in_days INT         NOT NULL,  -- 30, 60, or 90
  outcome_text  TEXT,
  recorded_at   TIMESTAMPTZ DEFAULT now(),
  prompted_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_inbox (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  topic         TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'queued',  -- queued, in-board, decided, outcome-pending, closed
  session_id    UUID        REFERENCES board_sessions(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_sessions_channel_idx
  ON board_sessions (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS board_sessions_user_idx
  ON board_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS board_outcomes_session_idx
  ON board_outcomes (session_id);

CREATE INDEX IF NOT EXISTS board_inbox_user_status_idx
  ON board_inbox (user_id, status, created_at ASC);
