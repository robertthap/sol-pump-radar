-- T1.3 — drift / meta-shift metrics (v2 plan, Sprint 3.5).
--
-- One row per drift-monitor tick: PSI of the core feature vector (recent window
-- vs baseline) on the unbiased universe sampler, + positive-label base rate. The
-- kill-gate reads meta_shift / max_psi to verify "window spanned ≥1 meta shift".

CREATE TABLE IF NOT EXISTS "drift_metrics" (
  "id"                   BIGSERIAL PRIMARY KEY,
  "computed_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "window_start"         TIMESTAMPTZ NOT NULL,
  "window_end"           TIMESTAMPTZ NOT NULL,
  "baseline_start"       TIMESTAMPTZ NOT NULL,
  "baseline_end"         TIMESTAMPTZ NOT NULL,
  "psi_by_feature"       JSONB       NOT NULL,
  "max_psi"              DOUBLE PRECISION NOT NULL,
  "meta_shift"           BOOLEAN     NOT NULL DEFAULT false,
  "positive_label_rate"  DOUBLE PRECISION,
  "baseline_n"           INTEGER     NOT NULL DEFAULT 0,
  "current_n"            INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "drift_metrics_computed_at_idx"
  ON "drift_metrics" ("computed_at");
