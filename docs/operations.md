# Operations

Status: **CURRENT**. Describes actual behaviour as of the Group 1–3 hardening pass.

Live execution is disabled (`RUNTIME_PROFILE=paper_safe`, `LIVE_EXECUTION=off`). Nothing in
this document enables it.

---

## Running the system

```bash
pnpm db:up && pnpm db:migrate     # Postgres 16 in Docker, then migrations
pnpm worker                        # terminal 1 — the automation runtime
pnpm dev                           # terminal 2 — UI + read APIs (127.0.0.1 only)
```

Auto-trading is **off after every restart** by design: the worker retires any session left
`active` at boot, so you must press Start explicitly. That is the primary safety property for
live mode and should not be "fixed".

The one opt-in exception is for paper evaluations: `RESUME_PAPER_SESSION_ON_BOOT=on` keeps an
active **paper** session (and the Demo selection) across a restart. Live sessions are always
retired.

### Long-running paper evaluations

```bash
pnpm worker:supervised             # instead of `pnpm worker`
```

`scripts/worker-supervisor.ps1` keeps the PC awake while it runs, starts Docker Desktop and the
Postgres container if they are down (they stop when the machine sleeps), runs the worker, and
restarts it with backoff (5 s → 60 s) whenever it exits. Pair it with
`RESUME_PAPER_SESSION_ON_BOOT=on` so the session survives those restarts.

---

## Pricing (single source)

Every price the system books or decides on comes from the chain (`lib/pricing/live-price.ts`):

| Coin phase | Source | Value |
|---|---|---|
| On the bonding curve | the bonding-curve account | curve-equivalent vSol from its spot price |
| Graduated | the canonical PumpSwap pool's two vaults | same scale, from the pool's spot price |
| Unknown | — | no price: fills are refused, exits hold |

"Curve-equivalent vSol" is `sqrt(price_sol_per_token × 32.19 × 1e9)`. It equals the raw virtual
SOL reserve on the standard curve and keeps non-standard curves (Mayhem mode) and graduated pools
on one scale, with no SOL/USD rate involved, so P&L `(current / entry)²` is exact in SOL.

Consumers: paper fills/closes/mark-to-market (`paperPriceResolver`), the exit loop (one batched
read per tick, persisted to `paper_positions.current_price` + `entry_features.price_at_ms`), the
`/trade` screen (shows that persisted price; older than 15 s shows as unpriced), live routing and
live exits. The pump.fun API is no longer used to price exits.

Ingestion stores the same scale: `lib/pump/parser.ts` derives `events.v_sol_after` from the
event's virtual SOL **and** token reserves, and decodes only TradeEvents emitted by the pump.fun
program (Raydium LaunchLab emits a same-named event with a different layout).

## Entry gates

Apply in every `ENTRY_MODE`: `MAX_ENTRY_AGE_SEC` (token age), `ENTRY_MIN_DEX_BUYS_M5`,
`MAX_ENTRY_MCAP_USD` (measured from the on-chain price), and `MAX_DECISION_AGE_SEC` (default 15:
a committed decision older than this at fill time is skipped).

## Live trade settlement

A live buy or sell is only booked once its transaction is confirmed on-chain:

- sent buy → `live_trades.status = 'pending'`; sent sell → `entry_features.pending_sell`
  (`status = 'pending_close'` for a full sell)
- `lib/workers/live-settlement.ts` (every 2 s) checks the signatures; on confirmation it reads
  the transaction and books the real fill (`lib/executor/swap-fill.ts`): entry price and all-in
  cost for a buy; proceeds, exit price, realized P&L, session stats and the notification for a sell
- not seen within 120 s, or failed on-chain: a buy is marked `failed`; an automatic exit returns
  to `open` and is retried; a manual sell becomes `close_failed`; a failed partial take-profit is
  cleared so it can fire again

Routing follows the on-chain phase: graduated → Jupiter; curve → PumpPortal `pool: "pump"`;
unknown phase → buys refused, sells via PumpPortal `pool: "auto"`. Live exits run the same exit
policy as paper (`lib/paper/exit-decision.ts`).

## Data quarantine

`scripts/quarantine-bad-data.ts` (dry run by default, `--apply` to act) moves rows the 2026-09-13
audit proved wrong into `trade_outcomes_quarantine` / `events_quarantine` with a reason, flags
phantom stop-outs in `paper_positions.entry_features.accounting_error`, and removes heartbeat rows
of deleted workers. Applied once on 2026-09-13: 51 outcomes (+78.97 SOL of fabricated P&L),
8 events, 5 heartbeat rows, 2 flagged positions. Reverse with `INSERT INTO trade_outcomes SELECT …`
from the quarantine table.

### Restart discipline

The worker does **not** hot-reload. Its in-memory state (prior-snapshot maps,
hot-mint registry) will otherwise overwrite corrected data.

```text
change worker-side code  ->  stop the worker  ->  build/test  ->  restart  ->  verify singleton
```

`pnpm build` kills a running worker. **Build last, never during a live session.**

---

## Worker singleton

One worker at a time, enforced by a PostgreSQL session-scoped advisory lock
(`lib/runtime/worker-lock.ts`). The key is exported as `WORKER_ADVISORY_KEY`
(`0x5350525f57524e30`, ASCII `SPR_WRN0`).

Boot order matters and is correct today: the lock is acquired at
`apps/worker/src/main.ts:71`, **before** the orchestrator starts at `:91`. A second worker
exits rather than double-ingesting. Clean shutdown releases the lock last, because it was
pushed onto the stop stack first.

### `pnpm worker:unlock`

Only for a lock orphaned by a crash or `SIGKILL` — Postgres can take minutes to notice a dead
backend.

It refuses to act while any lane has beaten within `WORKER_HEARTBEAT_TIMEOUT_MS` (60 s by
default). That threshold is now read from env rather than hard-coded, so this script and
`/api/runtime/health` cannot disagree about whether a worker is alive.

It terminates **only** backends holding our advisory key in the current database:

```sql
l.locktype = 'advisory'
AND l.objsubid = 1
AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint
AND a.datname = current_database()
```

It previously matched *every* advisory lock in the database and terminated all of them.

> **Known quirk:** `0x5350525f57524e30` exceeds `Number.MAX_SAFE_INTEGER`, so JavaScript
> evaluates it as `6003388872725254000` rather than the exact `…3680`. Harmless — acquire,
> release and the unlock filter all use the same imprecise constant. Do **not** "correct" it
> without a restart window: a corrected key would not match a lock held under the old value.

---

## Runtime data and retention

### `apps/worker/data/` — worker traces

Engine-B and intelligence JSONL traces written by the worker. **1.2 GB across 26 days** when
first measured, and it was *not* covered by `.gitignore` — `git add -A` would have staged all
of it. Now ignored explicitly.

| | |
|---|---|
| Contents | `engine-b-traces/YYYY-MM-DD.jsonl`, `intelligence-traces/YYYY-MM-DD.jsonl` |
| Written by | the intelligence commit lane, one line per evaluation |
| Read by | `pnpm engine-b:eval`, `engine-b:replay`, `engine-b:compare`, `intelligence:eval` |
| Tracked in git | **No** — ignored via `apps/worker/data/` |
| Pruned automatically | **No** |

**Retention policy: manual, and deliberately so.** These are research inputs, not operational
logs — deleting them destroys evidence the eval harnesses replay. Growth is roughly 45 MB/day
at current volume.

Recommended: keep the trailing 30 days on disk; archive or compress anything older rather than
deleting it, and only once no open evaluation depends on it. Check size with:

```bash
du -sh apps/worker/data
```

Note the `.gitignore` asymmetry: `/data/` is anchored to the repo root **on purpose**. An
unanchored `data/` previously matched `lib/chart/data/` and silently excluded 14 source files,
breaking CI. Keep the anchor; add explicit paths for other runtime dirs.

### `events` table

Pruned by the retention worker to `EVENT_RETENTION_DAYS` (default **7**). This is why the live
table holds ~20 k rows while a June backup holds 2.9 M. **Your backup rotation (7 days) is
exactly as long as the data itself** — lose a week of backups and the raw event history is
unrecoverable. `feature_snapshots` and `outcome_labels` are *not* pruned, which is correct:
they are the irreplaceable dataset.

---

## Backups

| Script | What it does |
|---|---|
| `scripts/backup-db.ps1` | `pg_dump -Fc -Z 9` inside the container, `docker cp` out, 7-day rotation. On-demand dumps are kept forever. |
| `scripts/restore-test.ps1` | Restores a dump into a temp DB, verifies 6 critical tables exist **and are non-empty**, drops the temp DB. |
| `scripts/safe-migrate.ps1` | Backup → restore to temp → dry-run the migration there → only then apply to live. |
| `scripts/install-backup-schedule.ps1` | Registers a 03:00 daily task (not armed by default). |

`restore-test.ps1` previously passed a schema-only restore: its row-count check parsed into a
throwaway `[ref]([int64]0)` and never compared to zero. It now fails on any critical table
with 0 rows.

Verified end to end against a real 1 GB dump: `events` 2,900,606 · `feature_snapshots` 142,761
· `outcome_labels` 132,308 · `wallet_profiles` 93,584.

> **PowerShell encoding trap:** every `scripts/*.ps1` is UTF-8 **without BOM**, so PowerShell
> 5.1 reads them as ANSI. A non-ASCII character inside a *string literal* breaks parsing.
> Keep new PowerShell edits ASCII-only. (A pre-existing em dash in a comment on
> `restore-test.ps1:3` is harmless — comments tolerate it.)

---

## Runbook

| Symptom | Cause | Fix |
|---|---|---|
| PowerShell commands fail mid-build | Docker Desktop stopped (often after sleep) | relaunch Docker Desktop, poll `docker info`, `pnpm db:up`, restart worker + dev |
| Worker dies during a build | `pnpm build` kills a running worker | build last |
| Auto-trader opens nothing | no active session (retired at boot), or all candidates vetoed | press Start; read `/api/auto/diagnostics` |
| Worker exits immediately | another worker holds the singleton lock | stop it, or `pnpm worker:unlock` if the heartbeat is stale |
| Live intents all rejected | vault locked | set `VAULT_PASSPHRASE` or `pnpm worker:unlock` |
| `env()` throws at boot | live flags set without `LIVE_CONFIRM` | set the token or turn live off — the guard is working |
| 404 on a route that exists, or `tsc` errors under `.next/types` | stale `.next` (dev generates route type stubs; deleted routes leave orphans) | stop dev, delete `.next`, restart |
| Events silently missing | ingest buffer hit `MAX_INGEST_QUEUE` | check `eventsDropped` on `/api/stats/ingestor` (newly exposed) |

---

## Observability

| Signal | Where |
|---|---|
| Ingest health, incl. **dropped events** | `/api/stats/ingestor` → `eventsDropped` |
| Worker lane liveness | `/api/runtime/health` (per-lane cadence-aware staleness) |
| Reaction time p50/p90/p95/p99/max | `/api/auto/session-insights` → `reaction` |
| Execution latency p50/p90/p95/p99/max | `/api/auto/session-insights` → `execLatency` (ms) |
| Auto-trader skip reasons | `/api/auto/diagnostics` |

`execLatency` covers **regular paper opens only** — the genesis, shadow-of-live and live paths
bypass the execution seam, so their trades carry no `exec_latency_ms`. Full ingest-to-execution
stage timing (`receivedAt` → `decodedAt` → `decisionAt` → `submittedAt`) is **not** implemented;
it needs plumbing through the commit lane and is deliberately deferred.
