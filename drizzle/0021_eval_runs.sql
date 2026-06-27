-- Upgrade-plan Phase 1 / B2: persist each paper-performance eval so the operator
-- gets an OOS-Sharpe + tail-loss TREND across the multi-week Phase 2 run (and can
-- spot a meta shift mid-flight), not just disconnected point-in-time prints.
CREATE TABLE IF NOT EXISTS eval_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  trades INT NOT NULL DEFAULT 0,
  win_rate DOUBLE PRECISION,
  mean_ret DOUBLE PRECISION,
  oos_sharpe DOUBLE PRECISION,
  tail_loss_p95 DOUBLE PRECISION,
  total_pnl_sol DOUBLE PRECISION,
  by_reason JSONB,
  by_age JSONB
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eval_runs_ran_at_idx ON eval_runs (ran_at);
