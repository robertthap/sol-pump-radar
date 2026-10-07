# Runbook — paper mode

How to start and stop a paper run, read the daily report, and stop everything
in a hurry. Written for the operator, not the developer.

**LIVE stays off.** Nothing in this runbook enables real trading. The central
guard in `lib/runtime/broadcast-guard.ts` refuses to broadcast unless
`RUNTIME_PROFILE=live`, `LIVE_EXECUTION=on`, `LIVE_DRY_RUN` not on, and
`LIVE_CONFIRM` is set to the confirm token — all four. Defaults are
`paper_safe`, off, on. Paper fills are simulated; no SOL moves.

---

## The kill switch (read this first)

**Stop all trading now:** click **Pause trading** in the top bar of
`http://127.0.0.1:3000/trade`.

Or from a terminal:

```cmd
curl -X POST http://127.0.0.1:3000/api/state/halt
```

This writes a `HALTED` row to `cb_events`. Entries stop immediately. **Exits
keep being managed** — a halt is a reason to stop buying, never a reason to
abandon an open position.

**It needs the worker running.** The API only *queues* the command;
`apps/worker` applies it. If the worker is down, the halt will not take effect
— stop the worker process instead, which also stops all trading.

**To resume:** click **Resume trading**, or `curl -X POST
http://127.0.0.1:3000/api/state/resume`. Watch the worker log for
`state -> RUNNING`.

Nothing in this codebase halts automatically. A `HALTED` state always means
someone pressed it.

---

## Before a measurement run

Do these once. Skipping them does not break the run — it makes its results
untrustworthy, which is worse, because the numbers still look like numbers.

```bash
pnpm db:up && pnpm db:migrate     # 0028/0029 add radar + research tables
pnpm verify:fee-model             # checks fees against real on-chain trades
pnpm measure:latency              # then set PAPER_LATENCY_* in .env
```

- **`verify:fee-model`** confirms the 1.25% curve and AMM fees against real
  pump.fun / PumpSwap transactions. Needs RPC access. If it reports a
  mismatch, report the measured value and change the constant deliberately —
  never tune it to make a backtest look better.
- **`measure:latency`** needs the worker to have been running with paper
  trading active. Until `PAPER_LATENCY_P50_MS` / `P90` / `P99` are set, fills
  use an **80–280 ms guess** and every trade is stamped
  `latencyMeasured=false`. Latency decides how much of a move a fill captures,
  so a guess biases results optimistically.

The script refuses to emit settings it does not trust (an incomplete profile,
or a p50 under 5 ms). That refusal is the correct output — do not override it.

### Freeze the config

Group 5 requires **one** config for the whole run. Set `.env` and do not touch
it until the run ends. Every trade records a `configHash`; the daily report
shouts if more than one appears in a day, because an average over two
configurations describes neither.

Set `GIT_SHA` to the commit you are running so trades can be split by code
version later.

---

## Start a run

Two terminals:

```bash
pnpm dev        # terminal 1 — UI and read APIs on 127.0.0.1:3000
pnpm worker     # terminal 2 — all automation
```

Only `apps/worker` runs automation. `pnpm dev` never does.

Then at `http://127.0.0.1:3000/trade`:

1. Confirm the banner reads **DEMO — PLAY MONEY**.
2. Check the breaker is not halted (no red banner in Auto trading).
3. Pick a strategy under **Select bot strategy**.
4. Press **Start bot**.

### Start CLEAN

Results from before this audit are **not comparable** with results after it —
H02 stopped refunding the entry fee and M03 raised the per-side fee from 1.00%
to 1.25%. Mixing them produces a meaningless average.

Use **Reset** on `/trade` to clear the paper portfolio before a measurement
run, and record the date you started.

---

## Stop a run

- **Stop the bot, keep the session:** press **Stop bot** on `/trade`.
- **Stop everything:** `Ctrl+C` in the worker terminal. Open positions remain
  in the database and are reconciled on the next boot.
- **Emergency:** use the kill switch above.

Stopping the worker mid-position leaves that position OPEN. It will appear in
the daily report under UNRESOLVED, which is the honest place for it.

---

## Read the daily report

```bash
pnpm daily:report                      # today, Australia/Sydney
pnpm daily:report -- --day 2026-10-06  # a specific risk day
```

Read-only. The day boundary is the **Australia/Sydney** risk day, the same one
the loss cap uses.

| Section | What to look at |
|---|---|
| **TRADES** | Net P&L in SOL and AUD. `A$ rate unavailable` means the FX rate was never fetched — the SOL figure is still good. |
| **DRAWDOWN** | Current drawdown from the peak. New entries stop past `PAPER_MAX_DRAWDOWN_PCT` (default 25%). |
| **UNRESOLVED** | Open positions and SOL committed. A large or old number here means the P&L above is incomplete. |
| **DATA INTEGRITY** | Unrecovered gaps and censored outcomes. Non-zero means some of the day happened where the system was not watching. |
| **RUN INTEGRITY** | The one to act on — see below. |

### RUN INTEGRITY warnings

- **`CONFIG CHANGED DURING THIS DAY`** — more than one `configHash`. Split the
  run at the change or restart it. Do not average across.
- **`trade(s) taken while an adaptive learner was running`** — turn
  `AUTO_TUNE`, `SHADOW_LEARNER` and `AUTO_CONTINUATION` off and restart.
- **`filled with the 80-280ms latency GUESS`** — run `pnpm measure:latency`.

`clean: one config, no learners, measured latency` is what you want to see.

---

## Judge the strategy

After enough clean data:

```bash
pnpm strategy:report      # writes STRATEGY_REPORT.md
```

Read-only. Walk-forward out-of-sample, pre- and post-graduation reported
separately, per-engine ablation, Brier score and reliability, and a plain
**edge / no edge** verdict.

It **refuses a verdict it cannot support** — too few trades, too few distinct
mints, or a look-ahead violation each block it. That refusal is a result. Do
not lower the thresholds to get an answer.

The default answer is **no edge**. Your own frozen specification already
reports all three strategies as indistinguishable from a matched random
control; the replication exists to check that, not to overturn it.

---

## When something looks wrong

| Symptom | Where to look |
|---|---|
| Bot will not start | Red banner on `/trade` → breaker halted. Resume it. |
| Resume does nothing | Worker not running. The API only queues the command. |
| Worker exits at startup | `Another apps/worker is already running` → kill the other process or `pnpm worker:unlock`. |
| `ws error ... 429` | RPC rate-limited; it falls back to public RPC and may drop events. Check `eventsDropped` in the ingestor stats. |
| AUD figures look wrong | `A$ rate unavailable` or `(stale rate)` means the FX rate is not live. SOL figures are unaffected. |
| No trades at all | Entry gates. Check the breaker, feed staleness, drawdown and per-mint exposure — all can refuse an entry, and all refuse rather than guess. |

---

## Checks before trusting any result

```bash
pnpm check     # typecheck + tests + package tests + lint
```

The database-backed accounting tests are separate and need a **throwaway**
database — they TRUNCATE the paper tables:

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/spr_test pnpm test:db
```

**Never point `TEST_DATABASE_URL` at a database holding real paper results.**
