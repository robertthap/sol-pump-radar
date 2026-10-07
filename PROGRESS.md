# Audit progress — Group 1 (paper accounting)

Handover file. Update after every commit so the next agent can continue cold.

**Branch:** `audit/group-1-paper-accounting`, based on `eee42a0`.
**Pushed:** no. Nothing in this audit has been pushed to any remote.
**Uncommitted work preserved:** nothing to preserve — the working tree was
clean when this branch was cut (`git status` empty, no stashes). The desktop's
earlier uncommitted work was already committed as `eac819f` in a prior session.

## Test setup

Two lanes, because one of these bugs only exists in the gap between what the
code reads and what it writes, and a pure test cannot reproduce a lost UPDATE.

| lane | command | needs a DB |
|---|---|---|
| pure | `pnpm test` | no — 539/539 |
| DB-backed | `TEST_DATABASE_URL=... pnpm test:db` | yes — 5/5 |

`pnpm test:db` is **skipped** unless `TEST_DATABASE_URL` is set, so the normal
suite stays database-free. It TRUNCATEs the paper tables on every test: point
it only at a throwaway database, never at one holding real paper results.

The cluster used here was a scratch Postgres 16 created for the audit, with all
30 `drizzle/*.sql` migrations applied. Nothing touched any runtime database.

## Status

| Code | Status | Commit | Test |
|---|---|---|---|
| H01 | **fixed** | `66ff217` | `executor-accounting.test.ts` — concurrent closes credit once |
| H02 | **fixed** | `42f007e` | `exit-settlement.test.ts` (7 pure) + 3 DB cases |
| M01 | **fixed** | `8cc8e0c` | `price-freshness.test.ts` (8 pure) |
| H03 | **fixed** | `07f0ddb` | `executor-accounting.test.ts` — fill after the delay |
| M03 | **fixed** | `3d5d253` | `fee-model.test.ts` (11 pure) |
| M04 | **fixed** | `0041b06` | `amounts.test.ts` (18 pure) |

**Group 1 is complete — all six findings fixed.**

Every fix made paper results **harsher**, never better. No threshold, sizing or
strategy parameter was touched.

### H01 — double credit on a concurrent close
`closePosition` read the position state outside the settling transaction, so two
racing closes both credited the portfolio. Measured: a 1 SOL position settled
twice paid out 1.98 SOL (10.00 → 9.00 → 10.98) and booked two losses.
Fix: `RETURNING id` + bail with `RACE_LOST` — the guard `partialClosePosition`
already had.

### H02 — entry fee refunded at exit
The entry fee only shrank `quantity`, which the curve settlement never reads.
Exits valued the position against the full cost basis, handing the fee back.
Measured: a 1 SOL flat round trip at 1%/side cost 0.0100 SOL; the true cost is
0.0199 — round-trip cost understated by ~half, on every trade.
Fix: new pure `curveExitSettlement`; only `basis − entryFee` compounds. The
entry fee is read from the recorded OPEN fill and apportioned pro rata so a
partial close and the final close sum to exactly one fee.

### M01 — fallback FX rate shown as fresh
`solPriceCacheSnapshot()` returned `ageMs: 0` for a never-fetched price. The
dashboard printed `10.000 SOL ≈ A$2,300` — exactly 10 × the hardcoded
`SOL_AUD_FALLBACK` — with no warning.
Fix: one shared pure rule `priceFreshnessAt()`; never-fetched has `ageMs: null`.
`stale` and `fallback` now travel with the numbers through `/api/market/sol-usd`
and `/api/ticker`; `solToAudDisplay` returns "A$ rate unavailable" for a guess
and marks "(stale rate)" for a real-but-old one.

### H03 — fills priced before the latency delay
All three fill paths quoted the market and then slept, booking a mark that
existed before the order could have landed. Measured: with a 60ms delay and the
market moving 100 → 150 at 20ms, the entry filled at 100.
Fix: await the delay first, quote after. Overrides are bookkeeping and still
neither wait nor re-quote.

### M03 — two fee models in one ledger
General paper charged 1.00%; research charged a hardcoded 1.25%; both wrote to
`paper_positions`. Neither charged the Solana base signature fee at all, and
neither modelled rent or failed-transaction cost.
Fix: `packages/trading/src/fees` is the single source — curve 1.25%
(0.95 protocol + 0.30 creator, measured), AMM 1.25% with the split recorded as
unmeasured rather than invented, base fee 0.000005 SOL charged on failures too,
ATA rent owed while open and refunded on close.

**FLAGGED ASSUMPTION:** the general engine's per-side fee ROSE from 1.00% to
1.25%. Not tuning — it makes every result worse, and 1.00% predates creator
fees. **Old paper results are not comparable with new ones.**

### M04 — float money
Lamports and raw token amounts were doubles. A 1e9-supply token at 6 decimals
is 1e15 raw units against a 9.007e15 ceiling — one order of magnitude from
silent precision loss.
Fix: `packages/trading/src/amounts`, BigInt throughout, throwing rather than
rounding past the safe range. Rounds half away from zero and rounds fees UP,
both against us. Wired into `lib/executor/swap-fill.ts`.

## Next — Group 2 (data integrity)

H07, H06, H04, H05, plus: affected outcomes marked censored, not deleted, and
excluded from training and evaluation.

## Not done / blocked

- **AUDIT_REPORT.md** not written: the Phase 1 discovery report was never
  attached to this session, so the full finding list (C01, H01–H14, M01–M07,
  L01) and its wording are unavailable here. Only the Group 1–2 codes named in
  the brief are known.
- **M03's on-chain validation is NOT done.** This container's network policy
  refuses Solana RPC (403 on CONNECT). Run `pnpm verify:fee-model` on a machine
  with RPC access before trusting any paper verdict — it is read-only.
- **The paper ledger's columns are still numeric/float.** M04 made the
  conversion layer exact; converting the schema is a migration, not a patch.
- Groups 3–5 not started.
