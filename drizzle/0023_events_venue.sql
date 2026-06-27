-- T1.2 — PumpSwap ingestion (v2 plan, Sprint 3).
--
-- Adds a `venue` discriminator + `pool` column to events so post-graduation
-- DEX trades live in the same table as bonding-curve trades. All prior rows
-- default to 'curve'. Curve-only consumers (M1 graduation math) filter
-- venue='curve'; wallet-history + label queries span both venues.

ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "venue" VARCHAR(16) NOT NULL DEFAULT 'curve';

ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "pool" VARCHAR(64);

-- Venue-aware indexes for the post-grad wallet-history + smart-money queries.
CREATE INDEX IF NOT EXISTS "events_mint_venue_ts_idx"
  ON "events" ("mint", "venue", "ts");

CREATE INDEX IF NOT EXISTS "events_wallet_venue_ts_idx"
  ON "events" ("wallet", "venue", "ts");
