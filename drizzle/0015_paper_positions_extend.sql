-- Extend paper_positions with the columns the legacy paper_trades table carried
-- so the new engine becomes the sole truth model. Adds entry_features (snapshot),
-- modules_at_entry, and TP1 partial-close columns. All nullable for backward
-- compatibility with rows opened before the migration.

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS entry_features jsonb,
  ADD COLUMN IF NOT EXISTS modules_at_entry jsonb,
  ADD COLUMN IF NOT EXISTS tp1_fraction double precision,
  ADD COLUMN IF NOT EXISTS tp1_realized_sol double precision,
  ADD COLUMN IF NOT EXISTS tp1_at_price double precision,
  ADD COLUMN IF NOT EXISTS tp1_at_ts timestamptz,
  ADD COLUMN IF NOT EXISTS decision_id bigint;

CREATE INDEX IF NOT EXISTS paper_positions_decision_idx
  ON paper_positions (decision_id);

-- Read-only compat view so existing readers (learner, shadow-learner,
-- analytics, etc) can be migrated incrementally. Maps the new column names
-- back to the legacy paper_trades shape. Writers DO NOT use this view; the
-- only writer is the new paper engine.
CREATE OR REPLACE VIEW paper_trades_compat AS
SELECT
  id,
  session_id,
  decision_id,
  mint,
  symbol,
  side,
  CASE state
    WHEN 'OPEN' THEN 'open'
    WHEN 'CLOSING' THEN 'open'
    WHEN 'CLOSED' THEN 'closed'
    ELSE lower(state)
  END                              AS status,
  entry_price                      AS entry_v_sol,
  exit_price                       AS exit_v_sol,
  notional_sol                     AS size_sol,
  realized_pnl_sol                 AS pnl_sol,
  unrealized_pnl_sol,
  current_price                    AS current_v_sol,
  stop_loss,
  take_profit,
  opened_at,
  closed_at,
  close_reason                     AS exit_reason,
  entry_features,
  modules_at_entry,
  tp1_fraction,
  tp1_realized_sol,
  tp1_at_price,
  tp1_at_ts,
  correlation_id
FROM paper_positions;
