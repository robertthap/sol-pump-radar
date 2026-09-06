/**
 * CLI: replay recorded position paths through candidate exit policies.
 *
 *   pnpm exit-eval            # last 7 days
 *   pnpm exit-eval --days 3
 *
 * Answers "would cutting flat positions sooner have paid?" for the population
 * the bot ACTUALLY trades, which no existing tool can: /api/backtest replays
 * `events`, and the graduated coins this system buys never appear there. The
 * input is position_marks (see drizzle/0026), so this only sees trades that
 * closed after that instrumentation shipped.
 *
 * Two things it cannot tell you, by construction:
 *   - What a freed slot would have earned. Slot-minutes freed is reported so you
 *     can weigh it, but the refill is counterfactual.
 *   - Anything at finer resolution than the ~30s mark cadence.
 *
 * Read-only.
 */
import { bootDb, getDb, getPool } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { scorePolicy, type ExitPolicy, type PathMark, type ScoredTrade } from "@/lib/paper/exit-policy-sim";

const days = (() => {
  const i = process.argv.indexOf("--days");
  const v = i >= 0 ? Number(process.argv[i + 1]) : 7;
  return Number.isFinite(v) && v > 0 ? v : 7;
})();

/** Minimum evidence before the table means anything. */
const MIN_TRADES = 100;
const MIN_SPAN_DAYS = 3;

function policies(): ExitPolicy[] {
  const base = { tpPct: 0.28, slPct: 0.12, maxHoldMs: 45 * 60_000, trailArmPct: 0.15, trailStopPct: 0.08 };
  const out: ExitPolicy[] = [
    // Self-check: this is what the balanced sessions actually ran.
    { name: "baseline (18m / <15%)", ...base, stagnationMs: 18 * 60_000 },
    { name: "no cut at all", ...base, stagnationMs: 0 },
    {
      name: "scalp (12m hold, 5m cut)",
      tpPct: 0.1, slPct: 0.08, maxHoldMs: 12 * 60_000,
      trailArmPct: 0.06, trailStopPct: 0.04,
      stagnationMs: 5 * 60_000, stagnationMaxPeakPct: 0.03,
    },
  ];
  // Grid: cut at N minutes when the peak never beat X.
  for (const min of [3, 5, 8, 12, 18]) {
    for (const peak of [0.02, 0.03, 0.05]) {
      out.push({
        name: `flatcut ${min}m / <${(peak * 100).toFixed(0)}%`,
        ...base,
        stagnationMs: min * 60_000,
        stagnationMaxPeakPct: peak,
      });
    }
  }
  // Dead flow: nobody has traded the coin for M seconds and we are not in profit.
  for (const sec of [120, 300, 600]) {
    out.push({ name: `deadflow ${sec}s`, ...base, stagnationMs: 18 * 60_000, deadFlowSec: sec });
  }
  return out;
}

async function main() {
  await bootDb();
  const res = await getDb().execute(sql`
    SELECT p.id::text AS id,
           p.notional_sol::float8 AS size_sol,
           p.realized_pnl_sol::float8 AS pnl_sol,
           p.close_reason::text AS close_reason,
           EXTRACT(EPOCH FROM (p.closed_at - p.opened_at))::float8 / 60 AS hold_min,
           COALESCE(p.entry_features->>'genesis_snipe', 'false') AS genesis
    FROM paper_positions p
    WHERE p.state = 'CLOSED'
      AND p.realized_pnl_sol IS NOT NULL
      AND p.notional_sol > 0
      AND COALESCE(p.entry_features->>'auto', 'true') = 'true'
      AND p.entry_features->>'shadow_of' IS NULL
      AND COALESCE(p.entry_features->>'genesis_snipe', 'false') <> 'true'
      AND p.closed_at > now() - (${sql.raw(String(days))} || ' days')::interval
      AND EXISTS (SELECT 1 FROM position_marks m WHERE m.position_id = p.id)
    ORDER BY p.closed_at ASC
  `);
  const rows = (res as unknown as {
    rows: Array<{ id: string; size_sol: number; pnl_sol: number; close_reason: string; hold_min: number }>;
  }).rows;

  if (rows.length === 0) {
    console.log(`\nNo closed trades with recorded marks in the last ${days} days.`);
    console.log("position_marks only covers trades opened after the instrumentation shipped —");
    console.log("let the bot run, then re-run this.\n");
    return;
  }

  // Ids come straight from the query above (our own bigints), so a raw numeric
  // list is safe here; drizzle cannot bind a JS array as bigint[].
  const idList = rows.map((r) => r.id).join(",");
  const marksRes = await getDb().execute(sql`
    SELECT position_id::text AS position_id, age_s, pct, peak_pct, last_trade_age_s
    FROM position_marks
    WHERE position_id IN (${sql.raw(idList)})
    ORDER BY position_id, age_s ASC
  `);
  const byPos = new Map<string, PathMark[]>();
  for (const m of (marksRes as unknown as {
    rows: Array<{ position_id: string; age_s: number; pct: number; peak_pct: number; last_trade_age_s: number | null }>;
  }).rows) {
    const list = byPos.get(m.position_id) ?? [];
    list.push({
      ageS: Number(m.age_s),
      pct: Number(m.pct),
      peakPct: Number(m.peak_pct),
      lastTradeAgeS: m.last_trade_age_s == null ? null : Number(m.last_trade_age_s),
    });
    byPos.set(m.position_id, list);
  }

  const trades: ScoredTrade[] = rows.map((r) => ({
    sizeSol: r.size_sol,
    actualPnlSol: r.pnl_sol,
    actualHoldMin: r.hold_min,
    path: byPos.get(r.id) ?? [],
  }));

  const marksPerTrade = trades.reduce((a, t) => a + t.path.length, 0) / trades.length;
  const actualPnl = trades.reduce((a, t) => a + t.actualPnlSol, 0);
  const actualWins = trades.filter((t) => t.actualPnlSol > 0).length;
  const actualSlotMin = trades.reduce((a, t) => a + t.actualHoldMin, 0);

  console.log(`\n=== Exit-policy replay — last ${days}d ===`);
  console.log(`${trades.length} closed trades with marks · ${marksPerTrade.toFixed(1)} marks/trade avg`);
  console.log(
    `ACTUAL: ${actualPnl >= 0 ? "+" : ""}${actualPnl.toFixed(4)} SOL · ` +
      `${((100 * actualWins) / trades.length).toFixed(1)}% win · ` +
      `${(actualSlotMin / trades.length).toFixed(1)} min avg hold · ${Math.round(actualSlotMin)} slot-min\n`,
  );

  const scored = policies().map((p) => scorePolicy(trades, p)).sort((a, b) => b.pnlSol - a.pnlSol);
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (v: number, n: number, d = 4) => v.toFixed(d).padStart(n);
  console.log(
    pad("policy", 26) + "   P&L SOL   win%  avg hold  slot-min  clipped  P&L given up",
  );
  console.log("-".repeat(92));
  for (const s of scored) {
    console.log(
      pad(s.name, 26) +
        num(s.pnlSol, 10) +
        num(s.winPct, 7, 1) +
        num(s.avgHoldMin, 10, 1) +
        num(s.slotMinutes, 10, 0) +
        String(s.winnersClipped).padStart(9) +
        num(s.pnlGivenUp, 14),
    );
  }

  console.log("");
  if (trades.length < MIN_TRADES) {
    console.log(
      `⚠ ${trades.length} trades is not enough to act on — aim for ${MIN_TRADES}+ across ${MIN_SPAN_DAYS}+ days.`,
    );
  }
  console.log("Slot-minutes freed is NOT profit: what a freed slot would have earned is not modelled.");
  console.log("'clipped' = trades the policy exited below what they actually realized.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
