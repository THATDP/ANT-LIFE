CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS world_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY,
  nickname varchar(18) NOT NULL,
  inventory jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS colony_events (
  id text PRIMARY KEY,
  kind varchar(24) NOT NULL,
  message text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS players_last_seen_idx ON players (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS colony_events_occurred_at_idx ON colony_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS world_state_updated_at_idx ON world_state (updated_at DESC);
