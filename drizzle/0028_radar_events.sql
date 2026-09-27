-- Coin Journey radar: what the auto-trader decided about each candidate, as it happened.
--
-- Why this exists: the entry gates in lib/workers/auto-trader.ts handleEntries (no price, market-cap ceiling,
-- activity floor, entry age, bundle veto, decision age, ...) only kept their reasons in memory for one tick
-- (bumpTransient) and a log line. A pending decision stays pending while it is refused, so decision_log never
-- learned why most candidates were not traded. The /radar screen reads this table to show where coins stop.
--
-- One row per decision per stage/reason, re-recorded at most every 30 s while a decision keeps hitting the same
-- gate (lib/radar/recorder.ts). The worker deletes rows older than a day. Additive only.

CREATE TABLE IF NOT EXISTS "radar_events" (
  "id"          bigserial PRIMARY KEY,
  "ts"          timestamptz NOT NULL DEFAULT now(),
  "mint"        varchar(64) NOT NULL,
  -- gate_passed | decision_committed | rejected | skipped
  "stage"       varchar(24) NOT NULL,
  -- the gate or skip reason code, e.g. mcap_ceiling, no_price, max_positions (null for passes)
  "sub_stage"   varchar(48),
  "score"       double precision,
  "detail"      varchar(160),
  "session_id"  bigint,
  "decision_id" bigint
);
--> statement-breakpoint
-- The radar reads a sliding window ("last 5 minutes") every 2 s; pruning deletes by age.
CREATE INDEX IF NOT EXISTS "radar_events_ts_idx" ON "radar_events" ("ts");
--> statement-breakpoint
-- "Which coins did the worker first see in the last N minutes" scans events by time; until now every events
-- index led with mint, wallet, kind or slot, so that range read the whole table.
CREATE INDEX IF NOT EXISTS "events_ts_idx" ON "events" ("ts");
