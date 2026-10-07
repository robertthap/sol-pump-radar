# Strategy report (H14)

> **STATUS: NO VERDICT. This has not been run on your data.**
>
> The harness is built and tested. It has **not** been run against your
> recorded trades, because the audit environment has no production database and
> no live feed. Nothing in this file is a statement about whether your strategy
> works.
>
> To produce the real report: `pnpm strategy:report` on your machine, with
> Postgres up. It overwrites this file.

## Why there is no verdict here

The audit ran in a cloud container. It has a throwaway Postgres built for
tests, which holds the handful of synthetic positions the test suite creates.
Running the report against it produces exactly what it should:

```
NO VERDICT: only 0 clean trades (need 100); only 0 distinct mints (need 50);
not enough data to build walk-forward folds
```

That is the harness working, not the harness failing. Reporting an edge from
nothing is the specific failure this audit exists to prevent, so the script
refuses rather than printing a confident-looking number.

**Two measurements must happen before any verdict is trustworthy**, and neither
could run here:

1. **`pnpm verify:fee-model`** — the fee constants (curve 1.25%, AMM 1.25%) are
   taken from your frozen specification and have not been checked against real
   on-chain transactions. The container's network policy refuses Solana RPC
   (403 on CONNECT).
2. **`pnpm measure:latency`** — fills currently use the 80–280 ms *guess*. Every
   trade is stamped `latencyMeasured=false` until you set `PAPER_LATENCY_*`.
   Latency decides how much of a move a paper fill captures, so an unmeasured
   one makes every result optimistic in the direction that matters.

## What the harness does

`packages/trading/src/evaluation` — pure, no IO, and unit-tested in both
directions: it reports **no edge on pure noise** and **finds a planted edge**.
A harness that can only find edges is worthless, because it will find one in
noise.

### Guards against the ways a memecoin backtest lies

| failure | what is done |
|---|---|
| **look-ahead** | Splits are time-ordered expanding-window, never shuffled. `assertNoLookAhead` *verifies* each fold tests strictly later data, and also fails a fold where one mint appears on both sides. A random K-fold on time series trains on the future and is the most common way a dead strategy reports an edge. |
| **clustering** | Returns within one mint share a price path and are not independent. The uncertainty interval resamples whole **mints**, not trades. Treating trades as independent makes the interval far too narrow and turns noise into significance. |
| **tail dominance** | The mean is reported beside the **median** and the 10% trimmed mean. A mean carried by one 50x cannot be traded: sizing cannot capture it and one missed outlier erases the result. |
| **censored data** | Trades taken while an adaptive learner was running are excluded via `measurementClean`; calibration uses only labels not censored over an ingest gap. Exclusion counts are reported, so the sample cannot quietly shrink. |

### The verdict rule

Deliberately hard to pass. The default answer is **no edge**; every check must
hold out of sample:

- enough trades, and enough distinct mints
- positive expected value out of sample
- mint-clustered 95% interval **excludes zero**
- profit factor above 1
- **median trade is not a loss** — this is what fails a lottery-ticket strategy
  whose mean looks good

### What the report contains when run

- Walk-forward out-of-sample stats, with the look-ahead check result stated
- **Pre-graduation (curve) and post-graduation (AMM) reported separately**
- Trades, win rate, average win/loss, profit factor, EV per trade with a
  mint-clustered 95% interval, median, trimmed mean, total P&L, max drawdown
- Per-engine ablation for M1–M5
- Brier score and a reliability table

### One honest limitation of the ablation

It splits each engine at the median of its own score and asks whether the half
it scored higher did better. That is **weaker** than a true leave-one-out
refit, which would need the training pipeline rather than a report. The report
says so in its own output rather than presenting it as more than it is.

## Context you should carry into reading the real report

From the frozen specification already in this repo: all three strategies
(Graduation Scout, Curve Ladder, Winner Scale-In) were reported as
**indistinguishable from a matched random control**. The replication in
`lib/strategies/` exists to check that negative result, not to overturn it.

Group 1 also changed how P&L is computed — the entry fee is no longer refunded
at exit (H02), and the per-side fee rose from 1.00% to 1.25% (M03). **Paper
results from before this audit are not comparable with results after it.**
Start the Group 5 run clean.
