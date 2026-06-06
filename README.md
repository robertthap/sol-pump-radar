# sol-pump-radar

A localhost-only Solana pump.fun analytics and (paper-first) trading dashboard.

Personal research tool. Not financial advice. High risk of total loss.

## Stack

- Node.js 20+, pnpm, Docker (Postgres 16)
- Cursor / VS Code (WSL2 on Windows recommended)

## First-time setup

```bash
cp .env.example .env.local
pnpm install
pnpm db:up
pnpm db:migrate
```

## Day-to-day (two terminals)

```bash
# terminal 1 — UI/API (read mostly; no workers)
pnpm dev

# terminal 2 — single automation runtime (ingest + intelligence + trading + chart WS)
pnpm worker
```

Open http://127.0.0.1:3000.

**Charts:** Live OHLC updates stream over WebSocket from the worker (`CHART_WS_PORT`, default `8788`). Set `NEXT_PUBLIC_CHART_WS_URL` if the browser is not on the same host as the worker. Historical candles load via REST either way.

## Layout

- `app/` — Next.js UI + API (reads from Postgres; writes only via the gate)
- `lib/` — shared server code (db client, repos, intelligence, workers)
- `apps/worker/` — single automation entry; boots Postgres and starts the orchestrator
- `packages/db/` — `@spr/db`: pool, migrations, web write gate
- `packages/core/` — `@spr/core`: events, trade FSM, projections
- `drizzle/` — SQL migrations (Postgres)
- `docker-compose.yml` — local Postgres 16

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm db:up` / `pnpm db:down` | Postgres container |
| `pnpm db:migrate` | apply SQL migrations |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm dev` | Next dev server |
| `pnpm build` then `pnpm start` | production-mode UI |
| `pnpm worker` | start the automation runtime |
| `pnpm typecheck` / `pnpm test` / `pnpm lint` | checks |
| `pnpm check` | typecheck + test + lint |
| `.\clean.ps1 -ArtifactsOnly` | clear `.next` and trace logs |
| `.\clean.ps1` | wipe Postgres volume + artifacts |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture
- [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) — runtime contract & cutover state
- [`docs/SECURITY.md`](docs/SECURITY.md) / [`docs/LEGAL.md`](docs/LEGAL.md)

## License

MIT
