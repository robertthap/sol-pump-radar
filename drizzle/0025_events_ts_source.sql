-- Time provenance for ingested events (Group 1, evidence integrity).
--
-- events.ts is written by classifyBlockTime(): it holds the on-chain blockTime
-- when that value is present and plausible, and silently falls back to our local
-- receive clock when it is not. Once stored the two are indistinguishable, so
-- every latency figure derived from events.ts has been mixing chain time with
-- receive time.
--
-- `ts_source` records which branch produced the value: 'chain' | 'local'.
--
-- Deliberately NULLABLE with NO DEFAULT. The `venue` column (0023) could default
-- to 'curve' because that was factually true of every prior row. Here the
-- existing rows are a MIX of chain and local time and their provenance is
-- genuinely unknown -- NULL means "unknown". Defaulting to 'chain' would
-- manufacture exactly the false confidence this column exists to remove.
--
-- Additive only: no backfill, no index, no rewrite of existing rows.

ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "ts_source" VARCHAR(8);
