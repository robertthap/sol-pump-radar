# Audit report

Status of every finding this audit covered, with the test that holds it closed.

> **Scope caveat.** The Phase 1 discovery report was never attached to the
> session that did this work, so the full finding list (C01, H01–H14, M01–M07,
> L01) and its original wording were not available. **The codes below are the
> ones named in the group briefs.** Findings in Phase 1 but not in a brief are
> listed as *not assessed* — they were never seen, not cleared.

Branch: `audit/group-1-paper-accounting`, 24 commits. **Not pushed.**

## Summary

| | count |
|---|---|
| Fixed, with a failing-first test | 18 |
| Out of scope (as instructed) | 5 |
| Not assessed (not in any brief) | unknown — see caveat |
| Verdict produced | **no** — see H14 |

Test suite: **689 pure** (524 at audit start), 15 package, 7 database-backed.

---

## Group 1 — paper accounting

| Code | Status | Commit | Test |
|---|---|---|---|
| H01 | **fixed** | `66ff217` | `executor-accounting.test.ts` |
| H02 | **fixed** | `42f007e` | `exit-settlement.test.ts` + 3 DB cases |
| H03 | **fixed** | `07f0ddb` | `executor-accounting.test.ts` |
| M01 | **fixed** | `8cc8e0c`, `d03a1a8` | `price-freshness.test.ts` |
| M03 | **fixed** | `3d5d253` | `fee-model.test.ts` |
| M04 | **fixed** | `0041b06` | `amounts.test.ts` |

**H01** — `closePosition` read state outside the settling transaction, so two
racing closes both credited. Measured: a 1 SOL position settled twice paid out
1.98 SOL and booked two losses.

**H02** — the entry fee only shrank `quantity`, which the curve settlement
never reads. A 1 SOL flat round trip at 1%/side cost 0.0100 when the true cost
is 0.0199: round-trip cost understated by **half, on every trade**.

**M01** — `solPriceCacheSnapshot()` reported a never-fetched price as
`ageMs: 0`. The dashboard printed `10.000 SOL ≈ A$2,300`, exactly 10× the
hardcoded fallback, with no warning. **Reopened and re-fixed in Group 5**: a
failed fetch stamped `at: now` onto the fallback, making it look real. The
first fix corrected how freshness was computed; that line corrupted the input.

**M03** — two fee models in one ledger: general paper 1.00%, research 1.25%.
Neither charged the Solana base signature fee at all. ⚠️ **The per-side fee
rose from 1.00% to 1.25%** — evidence-based and it makes results worse, but old
paper results are **not comparable** with new ones.

**M04** — lamports and raw token amounts were doubles. A 1e9-supply token at 6
decimals is 1e15 raw units against a 9.007e15 ceiling.

## Group 2 — data integrity

| Code | Status | Commit | Test |
|---|---|---|---|
| H04 | **fixed** | `92dcc80` | `gap-recovery.test.ts` |
| H05 | **fixed** | `273cbdc` | `gap-window.test.ts` |
| H06 | **fixed** | `38a91c1` | `gap-recovery.test.ts` (real mainnet logs) |
| H07 | **fixed** | `9e128d8` | `flush-queue.test.ts` |
| censor-not-delete | **fixed** | `77290a8` | `gap-window.test.ts` |

**H06** — the backfill could not see `meta.err`. Reverted transactions still
emit pump.fun logs, so **every gap recovery could manufacture trades that never
happened**.

**H07** — the flush spliced the batch out of the buffer *before* inserting, so
a DB failure destroyed up to 500 events; and the watermark advanced at decode
time, hiding the hole from the recovery that starts from the watermark.

**H05** — **`getWatermark()` was never called by anything.** Every restart began
at slot 0, so downtime produced no gap at all. The reconnect handler logged
"coalescing" while discarding the second window.

**Censoring** — `gapOverlaps` excluded `scope='unrecoverable'`, so permanently
missing windows produced labels that looked clean and fed training.

## Group 3 — paper realism and risk

| Item | Status | Commit | Test |
|---|---|---|---|
| central LIVE guard | **fixed** | `feb074b` | `broadcast-guard.test.ts` |
| M02 | **fixed** | `914f52f` | `risk-day.test.ts` |
| H09 | **fixed** | `ba89705` | `entry-gates.test.ts` |
| H10 (paper part) | **fixed** | `ba89705` | `entry-gates.test.ts` |
| M05 | **fixed** | `28aef37` | `latency.test.ts` |
| M06 | **fixed** | `d650092` | `provenance.test.ts` |
| M07 | **fixed** | `d650092` | `provenance.test.ts` + 2 DB cases |

**LIVE guard** — every check lived in a caller; `rpcSendBase64`, the single
broadcast site, consulted no flag at all. Exhaustive sweep: of 320 flag
combinations exactly 3 may broadcast. Mutation-verified.

**M02** — **five** daily-loss queries all used `now()::date`, the DB server's
day. On a UTC server it rolls mid-Sydney-morning, so **twice the intended risk**
got through. ⚠️ Also changed from gross-loss to **net** accounting, which makes
the cap looser — flagged, reversible in one function.

**H09/H10** — entries were allowed on a quiet or event-dropping feed, while the
breaker was PAUSED/DEGRADED, at any drawdown (`peak_equity_sol` was written and
never read), and with unlimited single-mint exposure. **Exits are not gated.**

**M05** — the 80–280 ms fill latency was a guess, never a measurement.

## Group 4 — honest strategy test

| Code | Status | Commit | Test |
|---|---|---|---|
| H14 harness | **built, validated** | `71bd304` | `evaluation.test.ts` (28 cases) |
| H14 **verdict** | **NOT PRODUCED** | — | no data in the audit environment |

The harness reports **no edge on pure noise** and **finds a planted edge** —
both asserted. Guards time-ordered splits (look-ahead *verified*, not assumed),
mint-clustered bootstrap, median and trimmed mean beside the mean, and excludes
censored and non-measurement-clean rows.

**Found:** `scripts/genesis-oos-validate.ts` does not filter `blocked_reason`,
so it evaluates over gap-censored rows.

## Group 5 — fresh paper run

| Item | Status | Commit |
|---|---|---|
| daily report | **built** | `d03a1a8` |
| config freeze detection | **built** | `d03a1a8` |
| RUNBOOK.md | **written** | this commit |
| config.example | **updated** | `d03a1a8` |
| the run itself | **NOT STARTED** | requires your machine |

## Out of scope (as instructed)

C01, H08, H12, H13, and the live-only parts of H10 and H11. **Not examined** —
no opinion is offered on them.

## Not assessed

H11 (paper part), and any Phase 1 finding not named in a group brief. Without
the Phase 1 report these could not be enumerated. **Absence here means not
looked at, not cleared.**

---

## Blocking a trustworthy result

Neither could run in the audit environment:

1. **`pnpm verify:fee-model`** — the 1.25% constants come from your frozen
   specification and are unchecked against real transactions. Solana RPC is
   refused here (403 on CONNECT).
2. **`pnpm measure:latency`** — fills use the 80–280 ms guess; every trade is
   stamped `latencyMeasured=false`.

Until both are done, no paper result should be read as evidence for going live.

## Known limitations of this audit

- **No verdict was produced.** Group 4 delivered the harness, not an answer.
- **The paper ledger is still float.** M04 made the conversion layer exact;
  converting the schema is a migration, not a patch.
- **The ablation splits on score rather than refitting**, which is a weaker
  claim than leave-one-out. The report says so in its own output.
- **Nothing was run against production data.** Every number quoted above was
  measured either on a throwaway Postgres or on recorded fixtures.
