# Continuation intelligence architecture

Canonical spec: [FORENSIC_CLARIFICATIONS.md](./FORENSIC_CLARIFICATIONS.md), [ARCHITECTURE_DECISIONS.md](./ARCHITECTURE_DECISIONS.md), [ENGINE_B_CONTRACT.md](./ENGINE_B_CONTRACT.md), [ENGINE_B_MEASUREMENT.md](./ENGINE_B_MEASUREMENT.md).

## System class

**Market state reconstruction engine** — `f(market_state) → decision + trace + measurable error`.

## Engine B entry

`lib/continuation/engine-b.ts` — `engineB()` / `engineBAsync()` with probabilistic fusion, cross-mint rank, state posteriors.

## Measurement

- Dual-write traces: PGlite `engine_b_traces` + JSONL `data/engine-b-traces/`
- Eval: `pnpm run engine-b:eval` → `GET /api/continuation/eval`
- Miss taxonomy: `lib/continuation/miss-classifier.ts`
- Replay: `pnpm run engine-b:replay` → `GET /api/continuation/replay`

## Workers

| Worker | Interval | Role |
|--------|----------|------|
| continuation-universe | 30s | discover → normalize → rank → engineB → candidates |
| continuation-event-stream | 5s | diff events → fast engineB + emit |
| intelligence-commit | 20s | fused BUY/SKIP → `decisions` |
| missed-winner-scan | 1h | eval set report |
| continuation-learner | stub | no auto-apply |

## UI

- `ContinuationPanel` — rank %, state, action
- `IntelligenceTruthViewer` — traces, miss, replay
- SignalDashboard filter **Continuation** (`engineB=1`)

## Integration (Option A)

Engine B: alerts + UI + trace. Engine A: trading. `AUTO_CONTINUATION=off` default.

## Phase status

| Phase | Status |
|-------|--------|
| Truth contract | Done — `ENGINE_B_CONTRACT.md` |
| Measurement layer | Done — traces, eval, replay CLI |
| 0 Ops | Done — health heartbeats, diagnostics |
| 1.5 Core | Done — normalizer, state, rank, fusion, engineB |
| 1 Universe | Done — discovery, event stream, workers |
| 2 UI | Done — panels, APIs, signal filter |
| 3 Replay/missed | Done — APIs + missed-winner-scan |
| 4 Tune | Done — env thresholds; learner stub |

## Migrations

- `0008_continuation_intelligence.sql`
- `0009_continuation_core.sql`
- `0010_engine_b_measurement.sql`
