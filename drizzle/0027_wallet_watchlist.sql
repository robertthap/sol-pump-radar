-- Operator-supplied "smart money" wallets to follow.
--
-- Why this exists: the operator has wallets they believe are profitable, and our
-- own wallet_profiles cannot currently confirm or deny that. Every one of our
-- 754,443 ingested events is venue='curve' (PUMPSWAP_INGEST defaults off), so a
-- wallet that buys on the bonding curve and takes profit after graduation looks
-- to the profiler like it bought and never sold -- booked as -100%. Four of the
-- 23 wallets supplied score exactly -1.000 with zero closed mints for that
-- reason. The statistical table is therefore biased AGAINST exactly the
-- behaviour that makes a wallet worth following.
--
-- So this table is deliberately NOT derived from wallet_profiles. It is operator
-- judgement, stored separately, and joined at entry time. Keeping the two
-- sources apart is the point: the operator's list is never diluted by our own
-- scoring, and our scoring is never overridden silently by the list.
--
-- Additive only: new table, no change to existing rows or columns.

CREATE TABLE IF NOT EXISTS "wallet_watchlist" (
  -- Base58 Solana address. PK because following the same wallet twice is a
  -- paste artifact, not an intent.
  "wallet"    varchar(64) PRIMARY KEY,
  "label"     varchar(64),
  "note"      varchar(200),
  -- Soft delete: a wallet that stopped working is worth keeping as a record of
  -- what was tried, so removal deactivates rather than erases.
  "active"    boolean NOT NULL DEFAULT true,
  "added_at"  timestamptz NOT NULL DEFAULT now()
);

-- The entry path asks "is this buyer watched?" on every candidate, so the
-- active subset is what needs to be cheap to scan.
CREATE INDEX IF NOT EXISTS "wallet_watchlist_active_idx" ON "wallet_watchlist" ("active") WHERE "active";
