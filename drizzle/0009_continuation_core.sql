-- Engine B core columns + replay / events

ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS momentum_state VARCHAR(32);
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS rank_percentile DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS vol_rank_percentile DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS liq_rank_percentile DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS rank_velocity DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS state_confidence DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS p_breakout DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS p_exhaustion DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS p_continuation DOUBLE PRECISION;
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS engine_b_action VARCHAR(32);
ALTER TABLE continuation_candidates ADD COLUMN IF NOT EXISTS engine_b_json JSONB;

CREATE TABLE IF NOT EXISTS normalized_snapshots (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS normalized_snapshots_mint_ts_idx ON normalized_snapshots (mint, ts DESC);

CREATE TABLE IF NOT EXISTS momentum_state_history (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_state VARCHAR(32),
  to_state VARCHAR(32) NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS momentum_state_history_mint_ts_idx ON momentum_state_history (mint, ts DESC);

CREATE TABLE IF NOT EXISTS continuation_events (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind VARCHAR(48) NOT NULL,
  payload JSONB
);
CREATE INDEX IF NOT EXISTS continuation_events_mint_ts_idx ON continuation_events (mint, ts DESC);

CREATE TABLE IF NOT EXISTS replay_snapshots (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  dex_features JSONB,
  continuation_score DOUBLE PRECISION,
  alert_action VARCHAR(32),
  engine_b_json JSONB
);
CREATE INDEX IF NOT EXISTS replay_snapshots_mint_ts_idx ON replay_snapshots (mint, ts DESC);

CREATE TABLE IF NOT EXISTS migration_events (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind VARCHAR(32) NOT NULL,
  pool VARCHAR(128),
  dex_id VARCHAR(32)
);
