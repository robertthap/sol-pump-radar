-- Upgrade-plan Phase 1: the measurement backbone.
--
-- Turn every evaluation into a clean, point-in-time training example, and let
-- forward outcomes mature ASYNCHRONOUSLY without ever mutating the feature row
-- (point-in-time correctness — no future value may leak into a feature).
--
--   feature_snapshots : immutable point-in-time feature vector + engine output.
--   outcome_labels    : forward outcomes per snapshot, filled once horizons mature.

CREATE TABLE IF NOT EXISTS feature_snapshots (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'universe' = a mint the engine actually scored; 'control' = a mint the gates
  -- would normally skip (selection-bias control, issue #2); 'shadow' = shadow trade.
  sample_source VARCHAR(16) NOT NULL DEFAULT 'universe',
  -- The point-in-time feature vector (token_features + dex flow + derived).
  features JSONB NOT NULL,
  -- The engine's outputs at this instant (signal, action, confidence, state, rank).
  engine_outputs JSONB,
  -- Source-health at capture (issue #4): { sol_price_stale, sol_price_fallback, dex_stale }.
  -- A snapshot flagged stale must NOT be used as a training row.
  stale_flags JSONB,
  -- Optional link to the decision_log row this snapshot corresponds to.
  decision_id BIGINT,
  -- Curve vSol (or effective vSol) at capture — the price basis for forward returns.
  ref_v_sol DOUBLE PRECISION,
  ref_mcap_usd DOUBLE PRECISION
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS feature_snapshots_mint_ts_idx ON feature_snapshots (mint, ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feature_snapshots_source_idx ON feature_snapshots (sample_source);
--> statement-breakpoint
-- Drives the label lane's "which snapshots have matured but are unlabelled?" scan.
CREATE INDEX IF NOT EXISTS feature_snapshots_ts_idx ON feature_snapshots (ts);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS outcome_labels (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES feature_snapshots(id) ON DELETE CASCADE,
  mint VARCHAR(64) NOT NULL,
  base_ts TIMESTAMPTZ NOT NULL,
  -- Forward returns at each horizon (fraction; NULL until that horizon matures).
  ret_5m DOUBLE PRECISION,
  ret_30m DOUBLE PRECISION,
  ret_1h DOUBLE PRECISION,
  ret_6h DOUBLE PRECISION,
  max_gain_pct DOUBLE PRECISION,
  max_drawdown_pct DOUBLE PRECISION,
  is_rug BOOLEAN,
  is_breakout BOOLEAN,
  time_to_peak_sec DOUBLE PRECISION,
  time_to_graduation_sec DOUBLE PRECISION,
  -- TRUE once the longest horizon (6h) has matured and labels are final.
  horizons_complete BOOLEAN NOT NULL DEFAULT false,
  label_ready_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One label row per snapshot.
CREATE UNIQUE INDEX IF NOT EXISTS outcome_labels_snapshot_uq ON outcome_labels (snapshot_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outcome_labels_mint_idx ON outcome_labels (mint);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outcome_labels_complete_idx ON outcome_labels (horizons_complete);
