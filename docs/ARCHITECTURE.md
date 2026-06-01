# Architecture

sol-pump-radar is a **localhost-only** pump.fun analytics and paper-first trading app. Two processes, one database.

## Processes

| Process | Role | Entry |
|---|---|---|
| Postgres | Sole durable truth (Docker, port 5432) | `pnpm db:up` |
| `apps/worker` | Single automation runtime: ingest, intelligence, FSM, trading | `pnpm worker` |
| Next.js | UI + read API + gated writes (no workers) | `pnpm dev` / `pnpm start` |

`instrumentation.ts` exists only to record a perf note. It does not boot workers and does not connect the DB.

## Repo layout

```
app/                    Next.js App Router (UI + API)
lib/
  workers/              orchestrator + setInterval workers (run from apps/worker only)
  intelligence/         dual-engine fusion + single commit authority
  continuation/         Engine B scoring + measurement
  db/                   Drizzle schema + Postgres client + migrations runner
  modules/              M1–M5 analytics
  executor/             paper + live execution
apps/
  worker/               canonical automation entry (imports lib/workers/orchestrator)
  web/                  placeholder (Next still runs at repo root)
packages/
  db/                   @spr/db: Pool, Drizzle, executeWebMutation gate
  core/                 @spr/core: appendEvent, trade FSM, projections, metrics
drizzle/                SQL migrations (Postgres)
docker-compose.yml      Postgres 16
```

## Intelligence pipeline

```
Collectors (ingestor WSS, Dex poll, analytics)
        ↓
Normalizer + continuation universe (30s)
        ↓
State delta + cross-mint rank
        ↓
intelligence-commit (3s, priority queue)
        ↓
decision_log + decision_trace (material) + JSONL traces
        ↓
auto-trader (pending queue, _auto_trade_allowed gate)
```

Only `commitIntelligenceDecision()` writes tradable decisions.

### Signal sources (priority)

1. **Analytics snapshot** — curve modules, hybrid/launch window
2. **Dex continuation** — migrated momentum (`continuation_candidates`)
3. **Launch hot (ingestor)** — gated `HOT_LAUNCH`, capped

## Database

- Docker **Postgres 16**, schema in `lib/db/schema/`, migrations applied at worker boot
- New runtime tables (`domain_events`, `ingest_facts`, `signals`, `trades_fsm`) in `drizzle/0013_runtime_execution_grade.sql`

## Frontend (mission control)

Primary UI: **`/mission`**.

- Single poll: `GET /api/intelligence/console`
- Token page bundle: `GET /api/intelligence/token-bundle?mint=`
- Signals SSE: `GET /api/signals/stream`
- Runtime visibility: `GET /api/runtime/postgres`, `GET /api/diagnostics/runtime`

## Principles

- Safety over speed; paper before live
- Bounded evaluation (priority queue, not full-universe every tick)
- Localhost only; no secrets in git
- One DB, one worker runtime, one web runtime
