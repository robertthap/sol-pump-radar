-- Per-position P&L / health path, sampled while a position is OPEN.
--
-- Why this exists: exit thresholds cannot be chosen from the current data. The
-- auto-trader now mostly buys GRADUATED coins, which trade on PumpSwap and are
-- therefore absent from `events` -- 58 of 60 recent trades have no reconstructable
-- price path. The worker does price them live (pump.fun market cap via
-- resolveCurrentForExit) but has only ever persisted the running peak
-- (entry_features.peak_pct / peak_at_ms), never the path. Without the path, any
-- "cut a dead position at N minutes" rule is a guess.
--
-- One row per open position per ~30s (not per 3s tick). Retention prunes at 14
-- days via runRetentionPrune's chunked delete, so this stays bounded: worst case
-- ~1.7 rows/s with 50 open positions.
--
-- Additive only: new table, no change to existing rows or columns.

CREATE TABLE IF NOT EXISTS "position_marks" (
  "id"                 bigserial PRIMARY KEY,
  "position_id"        bigint NOT NULL,
  "ts"                 timestamptz NOT NULL DEFAULT now(),
  -- Position age at the sample, seconds. The x-axis for any replay.
  "age_s"              integer NOT NULL,
  -- Unrealized P&L as a fraction of size, from markPnl (friction already applied).
  "pct"                double precision NOT NULL,
  -- Running max of pct up to this sample.
  "peak_pct"           double precision NOT NULL,
  "mcap_usd"           double precision,
  "graduated"          boolean NOT NULL DEFAULT false,
  -- Seconds since the coin's last trade (pump.fun last_trade_timestamp). The only
  -- "is anyone still trading this" signal available for graduated coins.
  "last_trade_age_s"   integer,
  -- Bonding-curve flow over the last 60s. NULL for graduated coins, whose trades
  -- are on PumpSwap and therefore not in `events`.
  "curve_trades_60s"   integer,
  "curve_wallets_60s"  integer
);

CREATE INDEX IF NOT EXISTS "position_marks_pos_ts_idx" ON "position_marks" ("position_id", "ts");
CREATE INDEX IF NOT EXISTS "position_marks_ts_idx" ON "position_marks" ("ts");
