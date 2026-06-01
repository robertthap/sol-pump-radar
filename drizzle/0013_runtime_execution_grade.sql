-- Execution-grade runtime tables

CREATE TABLE IF NOT EXISTS domain_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key VARCHAR(256),
  correlation_id VARCHAR(64)
);

CREATE UNIQUE INDEX IF NOT EXISTS domain_events_dedupe_key_uq
  ON domain_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingest_facts (
  id BIGSERIAL PRIMARY KEY,
  signature VARCHAR(96) NOT NULL,
  mint VARCHAR(64),
  raw JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedupe_key VARCHAR(256) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ingest_facts_dedupe_key_uq ON ingest_facts (dedupe_key);
CREATE INDEX IF NOT EXISTS ingest_facts_signature_idx ON ingest_facts (signature);
CREATE INDEX IF NOT EXISTS ingest_facts_mint_created_idx ON ingest_facts (mint, created_at DESC);

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  reason VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signals_mint_score_idx ON signals (mint, score DESC);

CREATE TABLE IF NOT EXISTS trades_fsm (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'INTENT',
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trades_fsm_state_idx ON trades_fsm (state);
