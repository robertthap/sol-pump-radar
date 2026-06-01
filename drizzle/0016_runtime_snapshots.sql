CREATE TABLE IF NOT EXISTS runtime_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_snapshots_captured_idx ON runtime_snapshots (captured_at DESC);
