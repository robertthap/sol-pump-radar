# Engine B Contract (frozen v1 / `b1`)

Engine B is a **market state reconstruction engine**: `f(market_state) → decision + trace + measurable error`.

## Canonical entry

```ts
engineB(mint, snapshot: NormalizedMintSnapshot, ctx: EngineBContext): EngineBResult
```

All workers call `engineB` only. Legacy `scoreContinuation` wraps `engineB`.

## Output (`EngineBResult`)

- `state`, `stateConfidence`, `statePosterior[]`
- `rankPercentile`, `rankVelocity`
- `continuationScore` (Score_B)
- `probabilities`: breakout, exhaustion, continuation
- `action`: `ALERT` | `WATCH` | `CONTINUATION_BUY` | `EXHAUSTION` | `NONE`
- `reason`: stable machine string

## Score_B

```
0.35 * RankMomentum + 0.25 * VelocityScore + 0.20 * StateConfidence
+ 0.15 * LiquidityQuality + 0.05 * EventImpulse
```

## Probability gates (override score)

| Condition | Action |
|-----------|--------|
| P_exhaustion > 0.70 | EXHAUSTION / WATCH, no buy |
| P_breakout_valid < 0.50 | WATCH / NONE |
| P_breakout_valid > 0.65 | ≥ ALERT |
| P_breakout_valid > 0.80 AND rank > 0.70 AND P_exhaustion < 0.50 | CONTINUATION_BUY |
| dominant state parabolic | cap at ALERT / EXHAUSTION |

## Integration (Option A)

Engine B: alerts, signals, UI, `decision_trace`. Engine A: trading. `AUTO_CONTINUATION` off by default.

## Version

`ENGINE_B_VERSION = "b1"` stored on traces and eval runs.
