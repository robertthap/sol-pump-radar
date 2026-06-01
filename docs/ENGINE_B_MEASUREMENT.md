# Engine B Measurement Layer

## Dual-write traces

- **PGlite** `engine_b_traces` — query/UI/API
- **JSONL** `data/engine-b-traces/YYYY-MM-DD.jsonl` — append-only source of truth

Insert-only. Replay reads JSONL first.

## Eval set (`ENGINE_B_EVAL_SET`)

Eight reference mints in `lib/continuation/eval-set.ts`. Versioned runs in `engine_b_eval_runs`.

## Miss classifier

Observation-only `MissType` for forensics — does not affect `engineB` gates.

## CLI

Runs outside Next.js via `tsconfig.cli.json` (stubs `server-only`) and loads `.env.local` automatically.

```powershell
cd C:\Users\rober\sol-pump-radar
pnpm run engine-b:eval
pnpm run engine-b:replay -- --mint=Ac8EScJ4ufRo8PiFkun7diUrcCCktg4JvArb3mPmpump
```

Do not put `# comments` on the same line in `cmd.exe` — they become extra script arguments.

- `pnpm run engine-b:eval` — eval set regression + MissType table
- `pnpm run engine-b:replay` — timeline replay (use `--` before flags for pnpm)
- `pnpm run engine-b:compare` — **validation stratum**: Engine A vs B head-to-head
- `GET /api/continuation/compare` — same report as JSON (`?evalOnly=1` for 8 mints only)

## Validation stratum (A vs B)

Answers: *Did Engine B fix detection vs Engine A baseline?*

Metrics per mint: first detection time, rank at signal, state timeline (B only), miss type A vs B, detection delta ms.

Trace timing fields: `firstSeenTs`, `firstSignalTs`, `firstRankEntryTs`, `firstStateTransitionTs`.

## Trace volume

- **A**: eval set (~8) on every eval run
- **B**: continuation candidates (~50–150/tick) in live workers
- Never full Dex 500+ universe
