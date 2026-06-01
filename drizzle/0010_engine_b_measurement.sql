-- Engine B measurement: traces + versioned eval runs

CREATE TABLE IF NOT EXISTS engine_b_traces (
  id BIGSERIAL PRIMARY KEY,
  mint VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace JSONB NOT NULL,
  action VARCHAR(32),
  score DOUBLE PRECISION,
  engine_b_version VARCHAR(16) NOT NULL DEFAULT 'b1'
);
CREATE INDEX IF NOT EXISTS engine_b_traces_mint_ts_idx ON engine_b_traces (mint, ts DESC);
CREATE INDEX IF NOT EXISTS engine_b_traces_ts_idx ON engine_b_traces (ts DESC);

CREATE TABLE IF NOT EXISTS engine_b_eval_runs (
  id BIGSERIAL PRIMARY KEY,
  eval_set_version VARCHAR(64) NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  market_snapshot_at TIMESTAMPTZ NOT NULL,
  report JSONB NOT NULL,
  engine_b_version VARCHAR(16) NOT NULL DEFAULT 'b1'
);
CREATE INDEX IF NOT EXISTS engine_b_eval_runs_run_at_idx ON engine_b_eval_runs (run_at DESC);
