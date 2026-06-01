# Localhost performance profile

Recommended defaults for free-tier, single-user, SSD + 16GB RAM.

## Run mode

```env
SIGNAL_MODE=hybrid
TRADER_MODE=paper
```

UI: `pnpm dev` (or `pnpm build && pnpm start`). Workers: `pnpm worker` in a second terminal.

## UI entry

Open **http://127.0.0.1:3000/mission** for mission control (momentum intelligence).  
`/terminal` redirects to `/mission`. Market trenches: `/market`. Signals log: `/signals`.

## Intelligence (single authority)

| Variable | Default | Meaning |
|----------|---------|---------|
| `INTELLIGENCE_TICK_MS` | 3000 | Commit worker interval |
| `INTELLIGENCE_UNIVERSE_MAX` | 150 | Active mint cap |
| `INTELLIGENCE_SKIP_UNCHANGED_MS` | 35000 | Cooldown if signal/state/rank unchanged |
| `INTELLIGENCE_TOP_RANK` | 20 | Always eval top rank |
| `INTELLIGENCE_MAX_EVAL_PER_TICK` | 60 | Max evals per tick |
| `INTELLIGENCE_MAX_LAUNCH_HOT_PER_TICK` | 12 | Launch slots (first priority in hybrid) |

Eval order: **launch hot → events → top rank → continuation hot (capped) → cooldown fill**.

## Launch hot (ingestor)

Gated `HOT_LAUNCH` — not on every create. See `LAUNCH_HOT_*` in `.env.example`.

## Storage

- **Postgres** (Docker, port 5432) — sole durable truth
- **JSONL** — `data/intelligence-traces/`, `data/engine-b-traces/`
- **Retention** — `EVENT_RETENTION_DAYS=7` (hourly prune)

## Worker intervals

| Worker | Interval |
|--------|----------|
| continuation-event-stream | 5s |
| intelligence-commit | 3s |
| continuation-universe | 30s |
| retention | 1h |

## Do not add (localhost)

Redis, Kafka, Geyser, ML inference, 500+ full-universe scans every tick.
