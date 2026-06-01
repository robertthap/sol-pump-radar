-- Continuation intelligence: universe, Dex features, decision trace

CREATE TABLE IF NOT EXISTS mint_registry (
  mint VARCHAR(64) PRIMARY KEY,
  symbol VARCHAR(32),
  name VARCHAR(128),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  engine_origin VARCHAR(24) NOT NULL DEFAULT 'discovery',
  lifecycle_state VARCHAR(24) NOT NULL DEFAULT 'unknown',
  migration_at TIMESTAMPTZ,
  primary_pool VARCHAR(128),
  primary_dex VARCHAR(32),
  pool_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mint_registry_updated_at_idx ON mint_registry (updated_at);

CREATE TABLE IF NOT EXISTS pool_registry (
  mint VARCHAR(64) NOT NULL,
  pair_address VARCHAR(128) NOT NULL,
  dex_id VARCHAR(32),
  liq_usd DOUBLE PRECISION,
  price_usd DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, pair_address)
);

CREATE INDEX IF NOT EXISTS pool_registry_mint_idx ON pool_registry (mint);

CREATE TABLE IF NOT EXISTS dex_features (
  mint VARCHAR(64) PRIMARY KEY,
  vol_m5 DOUBLE PRECISION,
  vol_h1 DOUBLE PRECISION,
  vol_h24 DOUBLE PRECISION,
  vol_acceleration DOUBLE PRECISION,
  liq_usd DOUBLE PRECISION,
  liq_growth_proxy DOUBLE PRECISION,
  buys_m5 INT,
  sells_m5 INT,
  buy_sell_ratio DOUBLE PRECISION,
  pool_count INT,
  trend_rank INT,
  price_change_m5 DOUBLE PRECISION,
  price_change_h1 DOUBLE PRECISION,
  price_change_h24 DOUBLE PRECISION,
  pair_created_at TIMESTAMPTZ,
  migration_age_hours DOUBLE PRECISION,
  continuation_score DOUBLE PRECISION,
  exhaustion_risk DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dex_features_updated_at_idx ON dex_features (updated_at);
CREATE INDEX IF NOT EXISTS dex_features_cont_score_idx ON dex_features (continuation_score DESC);

CREATE TABLE IF NOT EXISTS continuation_candidates (
  mint VARCHAR(64) PRIMARY KEY,
  continuation_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  trend_rank INT,
  source VARCHAR(32) NOT NULL DEFAULT 'dex',
  dex_h24_pct DOUBLE PRECISION,
  liq_usd DOUBLE PRECISION,
  alert_action VARCHAR(32),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS continuation_candidates_updated_at_idx ON continuation_candidates (updated_at);
CREATE INDEX IF NOT EXISTS continuation_candidates_score_idx ON continuation_candidates (continuation_score DESC);

CREATE TABLE IF NOT EXISTS decision_trace (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  mint VARCHAR(64) NOT NULL,
  stage VARCHAR(48) NOT NULL,
  engine VARCHAR(16) NOT NULL DEFAULT 'B',
  action VARCHAR(32),
  reason TEXT,
  vetoes JSONB,
  confidence DOUBLE PRECISION,
  feature_snapshot JSONB
);

CREATE INDEX IF NOT EXISTS decision_trace_mint_ts_idx ON decision_trace (mint, ts DESC);
CREATE INDEX IF NOT EXISTS decision_trace_stage_idx ON decision_trace (stage);
