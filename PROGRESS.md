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

### Group 2 — data integrity

| Code | Status | Commit | Test |
|---|---|---|---|
| H07 | **fixed** | `9e128d8` | `flush-queue.test.ts` (14 pure) |
| H06 | **fixed** | `38a91c1` | `gap-recovery.test.ts` (+3, real mainnet logs) |
| H04 | **fixed** | `92dcc80` | `gap-recovery.test.ts` (+4) |
| H05 | **fixed** | `273cbdc` | `gap-window.test.ts` (9 pure) |
| censored-not-deleted | **fixed** | `77290a8` | `gap-window.test.ts` (+4) |

**Group 2 is complete.**

### Group 3 — paper realism and risk

| Item | Status | Commit | Test |
|---|---|---|---|
| central LIVE guard | **fixed** | `feb074b` | `broadcast-guard.test.ts` (8) |
| M02 | **fixed** | `914f52f` | `risk-day.test.ts` (14) |
| H09 + H10 | **fixed** | `ba89705` | `entry-gates.test.ts` (10) |
| M06 + M07 | **fixed** | `d650092` | `provenance.test.ts` (12) + 2 DB |
| M05 | **fixed** | `28aef37` | `latency.test.ts` (14) |

**Group 3 is complete.**

### Group 4 — honest strategy test

| Item | Status | Commit | Test |
|---|---|---|---|
| H14 harness | **built + tested** | `71bd304` | `evaluation.test.ts` (28 pure) |
| H14 **verdict** | **NOT PRODUCED** | — | no data in this environment |

The harness is validated in BOTH directions: it reports no edge on pure noise
and finds a planted edge. Guards: time-ordered walk-forward with look-ahead
*verified* (not assumed), mint-clustered bootstrap, median/trimmed mean beside
the mean, censored and non-measurement-clean rows excluded.

`pnpm strategy:report` is read-only and writes STRATEGY_REPORT.md. It REFUSES
a verdict it cannot support — against the test DB it printed
`NO VERDICT: only 0 clean trades (need 100)`.

**Found:** `scripts/genesis-oos-validate.ts` does not filter `blocked_reason`,
so it evaluates over gap-censored rows. Only `ablation-report.ts` excluded
them. The new path excludes both censored and non-measurement-clean rows.

- **LIVE guard** — every check lived in a caller; `rpcSendBase64` consulted no
  flag at all. The guard now sits inside the single broadcast site and fails
  closed. Exhaustive sweep: of 320 flag combinations exactly 3 may broadcast.
  Mutation-verified — disabling it makes the choke-point test fail.
- **M02** — FIVE daily-loss queries all used `now()::date`, the DB server's day.
  On a UTC server that rolls mid-Sydney-morning, so twice the intended risk got
  through. One Sydney definition now, DST-aware; partial closes count.
- **H09/H10** — entries were allowed on a quiet or event-dropping feed, while
  the breaker was PAUSED/DEGRADED, at any drawdown (`peak_equity_sol` was
  written and never read), and with unlimited single-mint exposure. Gates fail
  closed. **Exits are deliberately not gated.**
- **M06/M07** — no provenance existed at all. Every trade now records code
  version, config hash, whether a learner was running, and whether latency was
  measured.
- **M05** — the 80–280ms fill latency was a guess. `pnpm measure:latency`
  samples the real path read-only; fills use the measurement when present and
  record `latencyMeasured=false` when not.

**Also found and fixed:** `packages/trading`'s own 15 tests were never run by
`pnpm test` (it globs `lib/**`). `pnpm check` now runs `test:trading`.

- **H07** — the flush spliced the batch out of the buffer BEFORE inserting, so
  any DB failure destroyed up to 500 events; and the watermark advanced at
  decode time, so the hole was invisible to gap recovery, which starts from the
  watermark. Now: peek, insert, commit, then advance to that batch's own slot.
- **H06** — the backfill had no way to see `meta.err`; reverted transactions
  still emit pump.fun logs, so every gap recovery could manufacture trades that
  never happened. Now checked on both the signature list and the fetched tx.
- **H04** — three ways a gap closed without being recovered: the 500-signature
  page cap exited silently, insert failures were swallowed by `.catch(log)`,
  and `failedMints` did not block closure. Now `shouldCloseGap` requires
  complete AND saved; otherwise the gap stays OPEN.
- **H05** — `getWatermark()` was never called by anything, so every restart
  began at slot 0 and the downtime produced no gap at all. The reconnect
  handler logged "coalescing" while discarding the second window. Both fixed.
- **censoring** — `gapOverlaps` excluded `scope='unrecoverable'`, so
  permanently missing windows produced labels that looked clean and fed
  training. Now censored with `blocked_reason`, never deleted, never retried.

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

### Group 5 — fresh paper run

| Item | Status | Commit |
|---|---|---|
| daily report | **built** | `d03a1a8` |
| config-freeze detection | **built** | `d03a1a8` |
| config.example | **updated** | `d03a1a8` |
| RUNBOOK.md | **written** | `a0b2e1f` |
| AUDIT_REPORT.md | **written** | `a0b2e1f` |
| **the run itself** | **NOT STARTED** | needs your machine |

**M01 REOPENED AND RE-FIXED.** Running the new daily report printed `A$0.00`
where it should have said the rate was unavailable. `getSolUsd()` stamped
`at: now` onto the FALLBACK values on a failed fetch, so the hardcoded A$230
looked like a live rate — defeating the Group 1 fix. The first fix corrected
how freshness was *computed*; that line corrupted the input it computed from,
which is why the original tests could not see it. `at` now means last
SUCCESSFUL fetch only.

## Audit complete — all five groups

Deliverables: `AUDIT_REPORT.md`, `STRATEGY_REPORT.md` (no verdict — see below),
`RUNBOOK.md`, `.env.example`, and the daily report script.

## What YOU must do — in this order

```bash
pnpm db:up && pnpm db:migrate   # 0028/0029 still unapplied
pnpm verify:fee-model           # fee constants unchecked against real trades
pnpm measure:latency            # fills still use the 80-280ms GUESS
# set PAPER_LATENCY_P50/P90/P99_MS and GIT_SHA in .env, then freeze it
# Reset the paper portfolio, start the worker, run for days
pnpm daily:report               # check RUN INTEGRITY says "clean"
pnpm strategy:report            # the verdict
```

**Do not read any paper result as evidence until the first three are done.**

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
- **Latency is NOT measured.** This container has no live feed, so
  `PAPER_LATENCY_*` are unset and every trade records `latencyMeasured=false`.
  Run `pnpm measure:latency` on your machine with the worker active.

- `pnpm test` is now 689 passing, up from 524 at the start of the audit.
