# sol-pump-radar

A **localhost-only** Solana pump.fun analytics and paper-first trading dashboard. Personal research tool for monitoring new launches, scoring continuation setups, and simulating (or optionally executing) trades from your own machine.

> **Not financial advice.** High risk of total loss. For personal use only — do not run as a service or accept other people's funds. See [`docs/LEGAL.md`](docs/LEGAL.md).

## Features

- **Mission control UI** — dark trading terminal at `/mission` with live intelligence console, token drill-down, and signal streaming (SSE)
- **Live candle charts** — OHLC updates over WebSocket from the worker; historical candles via REST
- **Dual-engine intelligence** — launch-hot sniper signals + Dex continuation scoring, fused through a single commit authority
- **Paper trading** — realistic simulation with slippage, fees, latency, position limits, and daily loss caps
- **Live execution (triple-gated)** — mainnet trades only when `RUNTIME_PROFILE=live`, `LIVE_EXECUTION=on`, and explicit confirmation are all set
- **Encrypted wallet vault** — local keypair storage; signing isolated from the web process
- **Postgres-backed event log** — durable audit trail, decision traces, and crash-safe position recovery

## Architecture

Two processes, one database:

| Process | Role | Command |
|---|---|---|
| **Postgres 16** | Sole durable truth | `pnpm db:up` |
| **Worker** | Ingest, intelligence, trading FSM, chart WebSocket | `pnpm worker` |
| **Next.js** | UI + read API + gated writes (no workers) | `pnpm dev` |

```
Collectors (pump.fun WSS, Dex poll, analytics)
        ↓
Normalizer + continuation universe
        ↓
Intelligence commit (priority queue, 3s tick)
        ↓
Decision log + auto-trader (paper / live)
        ↓
Mission control UI (poll + SSE + chart WS)
```

Full details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Tech stack

- **Runtime:** Node.js 20+, pnpm workspaces, TypeScript
- **Frontend:** Next.js 15, React 19, Tailwind CSS, TradingView Lightweight Charts
- **Backend:** Postgres 16 (Docker), Drizzle ORM, WebSocket (`ws`)
- **Solana:** `@solana/web3.js`, Jupiter quotes, pump.fun / PumpPortal routing
- **Wallet:** Phantom Connect SDK (optional), encrypted local vault

## Prerequisites

- Node.js 20+
- pnpm 9 (`corepack enable` or `npm i -g pnpm`)
- Docker Desktop (for Postgres)
- Windows: WSL2 recommended for worker stability

## Quick start

```bash
cp .env.example .env.local
pnpm install
pnpm db:up
pnpm db:migrate
```

### Day-to-day (two terminals)

```bash
# Terminal 1 — UI / API
pnpm dev

# Terminal 2 — automation runtime
pnpm worker
```

Open http://127.0.0.1:3000.

**Charts:** Live OHLC streams from the worker on `CHART_WS_PORT` (default `8788`). Set `NEXT_PUBLIC_CHART_WS_URL` if the browser is not on the same host.

## Project layout

```
app/                    Next.js App Router (UI + API)
lib/
  workers/              orchestrator + interval workers
  intelligence/         dual-engine fusion + commit authority
  continuation/         Engine B scoring
  executor/             paper + live execution
apps/worker/            canonical automation entry point
packages/
  db/                   @spr/db — pool, migrations, web write gate
  core/                 @spr/core — events, trade FSM, projections
  trading/              @spr/trading — paper engine, routing
drizzle/                SQL migrations
docker-compose.yml      local Postgres 16
```

## Configuration

Copy `.env.example` to `.env.local`. Key settings:

| Variable | Default | Purpose |
|---|---|---|
| `RUNTIME_PROFILE` | `paper_safe` | Hard gate: `paper_safe` / `dev` / `live` |
| `TRADER_MODE` | `paper` | `paper` / `devnet` / `live` |
| `SIGNAL_MODE` | `hybrid` | `hybrid` / `profit` / `launch` |
| `RISK_PRESET` | `aggressive` | `conservative` / `balanced` / `aggressive` |
| `PAPER_START_SOL` | `10` | Starting paper balance |
| `LIVE_EXECUTION` | `off` | Must be `on` for real mainnet txs |

See `.env.example` for the full list including RPC providers, intelligence tuning, and live risk limits.

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres container |
| `pnpm db:migrate` | Apply SQL migrations |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm dev` | Next.js dev server (127.0.0.1 only) |
| `pnpm build` then `pnpm start` | Production-mode UI |
| `pnpm worker` | Start automation runtime |
| `pnpm check` | typecheck + test + lint |
| `pnpm demo:freq-check --watch` | Monitor demo entry frequency |
| `.\clean.ps1 -ArtifactsOnly` | Clear `.next` and trace logs |
| `.\clean.ps1` | Wipe Postgres volume + artifacts |

## Safety defaults

- Dev server binds to **127.0.0.1** only — not exposed to LAN
- `RUNTIME_PROFILE=paper_safe` prevents any live transaction from firing
- Live execution requires three independent gates (profile + flag + confirmation string)
- `.env.local`, `data/`, and vault files are gitignored — never commit secrets

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full security model.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and data flow
- [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) — runtime contract and verification status
- [`docs/SECURITY.md`](docs/SECURITY.md) — localhost binding, vault, logging
- [`docs/LEGAL.md`](docs/LEGAL.md) — personal-use disclaimer

## License

MIT — see [LICENSE](LICENSE).
