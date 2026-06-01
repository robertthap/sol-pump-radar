-- Realistic paper trading engine: single portfolio, sessions, positions, fills.
-- Coexists with legacy paper_trades table (historical, read-only going forward).

-- Add session/correlation columns to domain_events for paper engine traceability.
ALTER TABLE domain_events
  ADD COLUMN IF NOT EXISTS session_id BIGINT;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS domain_events_session_idx ON domain_events (session_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS domain_events_correlation_idx ON domain_events (correlation_id);
--> statement-breakpoint

-- Sessions: one row per portfolio epoch (reset starts a new session).
CREATE TABLE IF NOT EXISTS paper_sessions (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  starting_balance_sol DOUBLE PRECISION NOT NULL,
  ending_balance_sol DOUBLE PRECISION,
  reset_reason VARCHAR(256)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS paper_sessions_active_idx
  ON paper_sessions (started_at DESC)
  WHERE ended_at IS NULL;
--> statement-breakpoint

-- Portfolio: exactly one row, id = 1. Enforced by CHECK.
CREATE TABLE IF NOT EXISTS paper_portfolio (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  session_id BIGINT NOT NULL REFERENCES paper_sessions(id),
  balance_sol DOUBLE PRECISION NOT NULL,
  equity_sol DOUBLE PRECISION NOT NULL,
  realized_pnl_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
  unrealized_pnl_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
  peak_equity_sol DOUBLE PRECISION NOT NULL,
  total_trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Positions: open + closed history.
CREATE TABLE IF NOT EXISTS paper_positions (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES paper_sessions(id),
  correlation_id VARCHAR(64),
  mint VARCHAR(64) NOT NULL,
  symbol VARCHAR(32),
  side VARCHAR(8) NOT NULL DEFAULT 'BUY',
  state VARCHAR(16) NOT NULL DEFAULT 'INTENT',
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION,
  quantity DOUBLE PRECISION NOT NULL,
  notional_sol DOUBLE PRECISION NOT NULL,
  current_price DOUBLE PRECISION,
  realized_pnl_sol DOUBLE PRECISION,
  unrealized_pnl_sol DOUBLE PRECISION,
  stop_loss DOUBLE PRECISION,
  take_profit DOUBLE PRECISION,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(32)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS paper_positions_open_idx
  ON paper_positions (state, opened_at DESC)
  WHERE state IN ('INTENT','OPEN','CLOSING');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS paper_positions_session_idx ON paper_positions (session_id, opened_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS paper_positions_mint_idx ON paper_positions (mint);
--> statement-breakpoint

-- Fills: audit log of every simulated buy/sell event.
CREATE TABLE IF NOT EXISTS paper_trade_fills (
  id BIGSERIAL PRIMARY KEY,
  position_id BIGINT NOT NULL REFERENCES paper_positions(id) ON DELETE CASCADE,
  fill_type VARCHAR(16) NOT NULL,
  fill_price DOUBLE PRECISION NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  notional_sol DOUBLE PRECISION NOT NULL,
  slippage_bps INTEGER NOT NULL DEFAULT 0,
  fee_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS paper_trade_fills_position_idx ON paper_trade_fills (position_id, created_at);
