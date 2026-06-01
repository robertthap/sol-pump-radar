# Dual-Engine Trading Intelligence Contract

Sol Pump Radar runs **two engines** with a single strict output envelope.

## Engines

| Engine | Role | States |
|--------|------|--------|
| **A** | Pre-migration / curve launch | `cold`, `launching`, `early_breakout`, `acceleration` |
| **B** | Post-migration Dex continuation | `cold`, `early_breakout`, `acceleration`, `trend`, `parabolic`, `exhaustion`, `collapse` |

## Non-negotiable rules

1. **Cross-mint competition** — `rank_percentile`, `velocity_rank`, `liquidity_rank` vs full universe.
2. **State before signal** — dominant state drives emission; score alone never decides.
3. **Event overrides** — `volume_spike` (≥2.5× m5), `liquidity_jump` (≥15%), `rank_jump` (≥+0.20 percentile), `new_pool_detected`, `migration_event`.
4. **Traceability** — every evaluation returns `reason`, `trigger_events`, and `miss_type` when non-actionable.

## Strict output (every mint)

```json
{
  "mint": "string",
  "engine": "A | B",
  "state": "string",
  "rank_percentile": 0.0,
  "signal": "BUY_STRONG | BUY_MODERATE | CONTINUATION_BUY | DEX_TREND_ALERT | EXHAUSTION_WARNING | WATCH | AVOID | NONE",
  "auto_trade_allowed": false,
  "confidence": 0.0,
  "reason": "pipe-delimited trace",
  "trigger_events": [],
  "miss_type": null
}
```

## Code entry points

- `lib/intelligence/dual-engine.ts` — `evaluateMintIntelligence()`, `evaluateUniverseIntelligence()`
- `lib/intelligence/engine-a-launch.ts` — Engine A state machine + signals
- `lib/intelligence/engine-b-output.ts` — wraps canonical `engineB()` → strict output
- `lib/intelligence/decision-bridge.ts` — `decideEngineAForUniverse()` for launch worker
- `lib/intelligence/event-triggers.ts` — spec thresholds (2.5× / 15% / 20%)
- `POST /api/intelligence/evaluate` — HTTP evaluate (single mint or batch)
- `pnpm run intelligence:eval` — CLI strict contract on eval mint set

## Localhost performance profile (recommended)

| Setting | Default | Role |
|---------|---------|------|
| `INTELLIGENCE_TICK_MS` | 3000 | Commit worker interval |
| `INTELLIGENCE_UNIVERSE_MAX` | 150 | Active mint cap |
| `INTELLIGENCE_SKIP_UNCHANGED_MS` | 35000 | Cooldown for unchanged signal/state/rank |
| `INTELLIGENCE_TOP_RANK` | 20 | Always evaluate top rank each tick |
| `INTELLIGENCE_MAX_EVAL_PER_TICK` | 60 | Priority queue cap per tick |
| `EVENT_RETENTION_DAYS` | 7 | Prune events + traces |

Traces: append-only JSONL under `data/intelligence-traces/`; PGlite `decision_trace` only on material change or commit.

### Launch hot (ingestor)

Gated `HOT_LAUNCH` on pump **create** — not unconditional. Requires ≥2 of: min curve liquidity (`LAUNCH_HOT_MIN_V_SOL`), trades, wallet diversity. Scored 0–1; top candidates per flush capped. TTL ~18s. Eval scheduler caps launch hot slots per tick (`INTELLIGENCE_MAX_LAUNCH_HOT_PER_TICK`).

## Production wiring (single authority)

| Worker | Role |
|--------|------|
| `intelligence-commit` | **Only** `decision_log` + trace + auto-trade gate (default 3s tick, priority queue) |
| `continuation-universe` | Normalize, score, persist candidates (no emit) |
| `continuation-event-stream` | Delta events → `continuation_events` (no emit) |
| `decision` | Analytics feeder + heartbeat only |
| `auto-trader` | Executes only `decision_log` rows with `_auto_trade_allowed >= 1` |

## Auto-trade gates

| Engine | Allowed when |
|--------|----------------|
| A | `BUY_STRONG`, state ∈ (`early_breakout`, `acceleration`), rank ≥ 0.80, liq ≥ $20k, no rug/bundle flags |
| B | `CONTINUATION_BUY`, state = `acceleration` only, rank ≥ 0.85, not parabolic/exhaustion, not extended (+300% h24 proxy) |

`AUTO_CONTINUATION=on` enables worker-side continuation auto; Engine A auto remains `auto-trader` + `qualifyEntry`.

## Miss types

`NOT_IN_UNIVERSE`, `NOT_NORMALIZED`, `NO_STATE_TRANSITION`, `LOW_RANK`, `LATE_PARABOLIC`, `EVENT_MISSED`, `OPS_FAILURE`, `GATE_BLOCKED`, `GATE_BLOCKED_EXHAUSTION`, `GATE_BLOCKED_LOW_BREAKOUT`
