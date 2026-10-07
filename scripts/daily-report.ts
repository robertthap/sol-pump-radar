/**
 * Group 5 — the daily paper report. READ-ONLY.
 *
 *   pnpm daily:report
 *   pnpm daily:report -- --day 2026-10-06      (a specific Sydney risk day)
 *   pnpm daily:report -- --session 12
 *
 * SELECTs only. It never writes, never migrates, and never touches a session
 * or the circuit breaker.
 *
 * The day boundary is the Australia/Sydney risk day (M02), the same one the
 * loss cap uses, so "today" means the same thing in the report as it does in
 * the risk check.
 *
 * Two things this report does that a dashboard typically does not:
 *
 *   1. It CHECKS THE CONFIG DID NOT MOVE. Group 5 says freeze one config for
 *      the run. Every trade carries its configHash (M07), so a run that was
 *      silently reconfigured mid-way is detectable rather than quietly averaged
 *      — and an average over two configurations describes neither.
 *   2. It reports what it could NOT account for: unresolved positions and
 *      ingest gaps. A P&L figure that hides them is not a P&L figure.
 */
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import { riskDayWindow, riskDayKey } from "@spr/trading";
import { solPriceCacheSnapshot, getSolUsd } from "@/lib/market/sol-usd";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const sol = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)} SOL`;

type Row = Record<string, unknown>;
async function q<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const res = await getDb().execute(query);
  return (res as unknown as { rows: T[] }).rows;
}

async function main() {
  await bootDb();

  const dayArg = arg("day");
  const reference = dayArg ? new Date(`${dayArg}T12:00:00+10:00`) : new Date();
  const { start, end } = riskDayWindow(reference);
  const key = riskDayKey(reference);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  console.log(`\n=== Paper daily report — ${key} (Australia/Sydney) ===`);
  console.log(`Window: ${startIso} .. ${endIso}`);
  console.log("READ-ONLY: SELECTs only.\n");

  // ---------------------------------------------------------------- trades --
  const closed = await q<{
    pnl: number; ret: number; notional: number; fees: number;
    config_hash: string | null; code_version: string | null;
    measurement_clean: boolean; latency_measured: boolean;
  }>(sql`
    SELECT
      p.realized_pnl_sol::float8 AS pnl,
      CASE WHEN p.notional_sol > 0 THEN (p.realized_pnl_sol / p.notional_sol)::float8 ELSE 0 END AS ret,
      p.notional_sol::float8 AS notional,
      COALESCE((SELECT SUM(fee_sol) FROM paper_trade_fills WHERE position_id = p.id), 0)::float8 AS fees,
      p.entry_features->>'configHash' AS config_hash,
      p.entry_features->>'codeVersion' AS code_version,
      COALESCE((p.entry_features->>'measurementClean')::boolean, false) AS measurement_clean,
      COALESCE((p.entry_features->>'latencyMeasured')::boolean, false) AS latency_measured
    FROM paper_positions p
    WHERE p.state = 'CLOSED'
      -- A CENSORED close has realized_pnl_sol NULL: it finished, but its
      -- outcome is unavailable. Summing it as 0 would report "+0.0000 SOL" for
      -- a P&L nobody knows — missing data dressed as a real number, which is
      -- the failure this whole report exists to avoid. Counted separately below.
      AND p.realized_pnl_sol IS NOT NULL
      AND p.closed_at >= ${startIso}::timestamptz
      AND p.closed_at <  ${endIso}::timestamptz
  `);

  const censoredCloses = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM paper_positions
    WHERE state = 'CLOSED' AND realized_pnl_sol IS NULL
      AND closed_at >= ${startIso}::timestamptz
      AND closed_at <  ${endIso}::timestamptz
  `);

  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const net = closed.reduce((a, t) => a + t.pnl, 0);
  const fees = closed.reduce((a, t) => a + t.fees, 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  await getSolUsd().catch(() => undefined);
  const price = solPriceCacheSnapshot();
  // M01: never present a fallback rate as a real one.
  const aud = price.usingFallback
    ? "A$ rate unavailable"
    : `A$${(net * price.aud).toFixed(2)}${price.stale ? " (stale rate)" : ""}`;

  console.log("TRADES");
  console.log(`  closed              ${closed.length}`);
  console.log(`  win rate            ${closed.length ? pct(wins.length / closed.length) : "—"}`);
  console.log(`  average win         ${wins.length ? pct(avg(wins.map((t) => t.ret))) : "—"}`);
  console.log(`  average loss        ${losses.length ? pct(avg(losses.map((t) => t.ret))) : "—"}`);
  console.log(`  fees paid           ${fees.toFixed(5)} SOL`);
  console.log(`  net P&L             ${sol(net)}   ${aud}`);
  const censoredN = censoredCloses[0]?.n ?? 0;
  if (censoredN > 0) {
    console.log(`  censored closes     ${censoredN} (outcome unavailable — EXCLUDED from the figures above)`);
  }

  // ------------------------------------------------------------- drawdown ---
  const pf = await q<{ equity: number; peak: number; balance: number }>(sql`
    SELECT equity_sol::float8 AS equity, peak_equity_sol::float8 AS peak, balance_sol::float8 AS balance
    FROM paper_portfolio WHERE id = 1
  `);
  if (pf[0]) {
    const { equity, peak } = pf[0];
    const current = peak > 0 ? Math.max(0, (peak - equity) / peak) : 0;
    console.log("\nDRAWDOWN");
    console.log(`  equity / peak       ${equity.toFixed(4)} / ${peak.toFixed(4)} SOL`);
    console.log(`  current drawdown    ${pct(current)}`);
  }

  // ------------------------------------------------- unresolved positions ---
  // A P&L figure that hides what it could not close is not a P&L figure.
  const open = await q<{ n: number; oldest: string | null; notional: number }>(sql`
    SELECT count(*)::int AS n,
           min(opened_at)::text AS oldest,
           COALESCE(SUM(notional_sol), 0)::float8 AS notional
    FROM paper_positions WHERE state IN ('OPEN','CLOSING','INTENT')
  `);
  console.log("\nUNRESOLVED");
  console.log(`  open positions      ${open[0]?.n ?? 0} (${(open[0]?.notional ?? 0).toFixed(4)} SOL committed)`);
  if (open[0]?.oldest) console.log(`  oldest opened       ${open[0].oldest}`);

  // ------------------------------------------------------------ data gaps ---
  const gaps = await q<{ n: number; unrecoverable: number }>(sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE scope = 'unrecoverable')::int AS unrecoverable
    FROM ingest_gaps
    WHERE NOT recovered
      AND ended_ts >= ${startIso}::timestamptz
      AND started_ts < ${endIso}::timestamptz
  `);
  const censored = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM outcome_labels
    WHERE blocked_reason IS NOT NULL
      AND base_ts >= ${startIso}::timestamptz AND base_ts < ${endIso}::timestamptz
  `);
  console.log("\nDATA INTEGRITY");
  console.log(`  unrecovered gaps    ${gaps[0]?.n ?? 0} (${gaps[0]?.unrecoverable ?? 0} unrecoverable)`);
  console.log(`  censored outcomes   ${censored[0]?.n ?? 0}`);

  // -------------------------------------------------------- config freeze ---
  const hashes = [...new Set(closed.map((t) => t.config_hash ?? "none"))];
  const versions = [...new Set(closed.map((t) => t.code_version ?? "unknown"))];
  const dirty = closed.filter((t) => !t.measurement_clean).length;
  const guessed = closed.filter((t) => !t.latency_measured).length;

  console.log("\nRUN INTEGRITY");
  console.log(`  config hashes       ${hashes.join(", ") || "—"}`);
  console.log(`  code versions       ${versions.join(", ") || "—"}`);
  if (hashes.length > 1) {
    console.log("  !! CONFIG CHANGED DURING THIS DAY. Group 5 requires ONE frozen config.");
    console.log("     These trades came from different configurations; their average");
    console.log("     describes none of them. Split the run at the change, or restart.");
  }
  if (dirty > 0) {
    console.log(`  !! ${dirty} trade(s) taken while an adaptive learner was running.`);
    console.log("     Not measurement-grade. Turn AUTO_TUNE / SHADOW_LEARNER /");
    console.log("     AUTO_CONTINUATION off and restart the session.");
  }
  if (guessed > 0) {
    console.log(`  !! ${guessed} trade(s) filled with the 80-280ms latency GUESS.`);
    console.log("     Run `pnpm measure:latency` and set PAPER_LATENCY_P50/P90/P99_MS.");
  }
  if (hashes.length <= 1 && dirty === 0 && guessed === 0 && closed.length > 0) {
    console.log("  clean: one config, no learners, measured latency.");
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); });
