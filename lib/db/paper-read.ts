/**
 * Read-only SQL source: inline compat over paper_positions (replaces paper_trades_compat VIEW).
 * Writers must use @/lib/paper/engine (paperOpen/paperClose), never raw INSERTs.
 */
export const PAPER_TRADES_READ = `(
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
  FROM paper_positions
)`;

/** Canonical table name for new queries. */
export const PAPER_POSITIONS_TABLE = "paper_positions";

export const PAPER_OPEN_WHERE = "state = 'OPEN'";
export const PAPER_CLOSED_WHERE = "state = 'CLOSED'";
