CREATE TABLE IF NOT EXISTS app_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_state_updated_at ON app_state (updated_at);
