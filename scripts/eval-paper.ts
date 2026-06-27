/**
 * CLI: honest out-of-sample paper performance (upgrade-plan Phase 1, §7 item #4).
 * Usage: pnpm eval-paper
 *
 * Reads CLOSED paper_positions and reports the numbers that actually decide
 * whether to proceed (Phase 2 gate): out-of-sample, TIME-ORDERED, risk-adjusted.
 * NOT hit rate, NOT in-sample backtest. Trades are split into sequential
 * walk-forward folds so you can see whether any edge survives a meta shift.
 */
import { bootDb, getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { fetchMeasurementCounts } from "@/lib/db/repos/measurement";
import { evalRuns } from "@/lib/db/schema/measurement";

type Trade = {
  ret: number;
  pnl: number;
  closedAt: Date;
  reason: string;
  tier: string;
  regime: string;
  /** Token age (s) at entry — our reaction latency. Late entries = structural disadvantage. */
  ageSec: number | null;
};

/** Reaction-latency bucket for the entry-age breakdown (A5). */
function ageBucket(ageSec: number | null): string {
  if (ageSec == null) return "age:unknown";
  if (ageSec < 10) return "age:<10s";
  if (ageSec < 60) return "age:10-60s";
  if (ageSec < 300) return "age:1-5m";
  if (ageSec < 1800) return "age:5-30m";
  return "age:>30m";
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
/** Per-trade Sharpe (mean/σ of returns); 0 when σ=0. */
function sharpe(xs: number[]): number {
  const s = std(xs);
  return s > 0 ? mean(xs) / s : 0;
}
/** p in [0,1]; linear-interpolated percentile of a copy-sorted array. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo]!;
  return a[lo]! + (a[hi]! - a[lo]!) * (idx - lo);
}

type Metrics = { n: number; winRate: number; mean: number; sharpe: number; tailP95: number; totalPnl: number };
function metricsOf(ts: Trade[]): Metrics {
  const rets = ts.map((t) => t.ret);
  return {
    n: ts.length,
    winRate: ts.length ? rets.filter((r) => r > 0).length / ts.length : 0,
    mean: mean(rets),
    sharpe: sharpe(rets),
    tailP95: ts.length ? percentile(rets, 0.05) : 0,
    totalPnl: ts.reduce((a, t) => a + t.pnl, 0),
  };
}

function summarise(label: string, ts: Trade[]): string {
  if (ts.length === 0) return `${label.padEnd(16)} (no trades)`;
  const rets = ts.map((t) => t.ret);
  const wins = rets.filter((r) => r > 0).length;
  const tailLossP95 = percentile(rets, 0.05); // 5th-pct return = the bad-tail
  const totalPnl = ts.reduce((a, t) => a + t.pnl, 0);
  return [
    label.padEnd(16),
    `n=${String(ts.length).padStart(4)}`,
    `win=${((wins / ts.length) * 100).toFixed(0).padStart(3)}%`,
    `mean=${(mean(rets) * 100).toFixed(2).padStart(7)}%`,
    `sharpe=${sharpe(rets).toFixed(3).padStart(7)}`,
    `tailP95=${(tailLossP95 * 100).toFixed(1).padStart(7)}%`,
    `pnl=${totalPnl.toFixed(4).padStart(9)} SOL`,
  ].join("  ");
}

function groupBy(ts: Trade[], key: (t: Trade) => string): Map<string, Trade[]> {
  const m = new Map<string, Trade[]>();
  for (const t of ts) {
    const k = key(t);
    (m.get(k) ?? m.set(k, []).get(k)!).push(t);
  }
  return m;
}

async function main() {
  await bootDb();
  const res = await getDb().execute(sql`
    SELECT
      realized_pnl_sol::float8 AS pnl,
      notional_sol::float8 AS size,
      closed_at,
      COALESCE(close_reason, 'n/a') AS reason,
      COALESCE(entry_features->>'entry_tier', 'n/a') AS tier,
      COALESCE(entry_features->>'regime', 'n/a') AS regime,
      (entry_features->>'entry_age_seconds')::float8 AS entry_age_sec
    FROM paper_positions
    WHERE state = 'CLOSED' AND realized_pnl_sol IS NOT NULL AND notional_sol > 0
    ORDER BY closed_at ASC
  `);
  const rows = (
    res as unknown as {
      rows: Array<{
        pnl: number; size: number; closed_at: Date | string; reason: string;
        tier: string; regime: string; entry_age_sec: number | null;
      }>;
    }
  ).rows;

  const trades: Trade[] = rows.map((r) => ({
    ret: r.pnl / r.size,
    pnl: r.pnl,
    closedAt: r.closed_at instanceof Date ? r.closed_at : new Date(r.closed_at),
    reason: r.reason,
    tier: r.tier,
    regime: r.regime,
    ageSec: r.entry_age_sec,
  }));

  console.log("\n=== Paper performance (out-of-sample, time-ordered) ===\n");
  if (trades.length === 0) {
    console.log("No closed paper trades yet. Run a paper session, then re-run.\n");
  } else {
    console.log(summarise("OVERALL", trades));
    console.log(
      `  span: ${trades[0]!.closedAt.toISOString().slice(0, 16)} → ${trades.at(-1)!.closedAt.toISOString().slice(0, 16)}`,
    );

    // Walk-forward: sequential folds expose whether edge holds across a meta shift.
    const FOLDS = Math.min(4, Math.max(1, Math.floor(trades.length / 10)));
    if (FOLDS > 1) {
      console.log(`\n--- Walk-forward (${FOLDS} sequential folds) ---`);
      const per = Math.ceil(trades.length / FOLDS);
      for (let i = 0; i < FOLDS; i++) {
        console.log(summarise(`fold ${i + 1}/${FOLDS}`, trades.slice(i * per, (i + 1) * per)));
      }
    }

    console.log("\n--- By exit reason ---");
    for (const [k, v] of [...groupBy(trades, (t) => t.reason)].sort((a, b) => b[1].length - a[1].length)) {
      console.log(summarise(k, v));
    }

    const byTier = groupBy(trades, (t) => t.tier);
    if (byTier.size > 1 || !byTier.has("n/a")) {
      console.log("\n--- By entry tier ---");
      for (const [k, v] of byTier) console.log(summarise(k, v));
    }

    const byRegime = groupBy(trades, (t) => t.regime);
    if (byRegime.size > 1 || !byRegime.has("n/a")) {
      console.log("\n--- By regime ---");
      for (const [k, v] of byRegime) console.log(summarise(k, v));
    }

    // Reaction latency (A5): if late entries systematically lose, that's a
    // structural signal — the coins moved before we arrived.
    console.log("\n--- By entry age (reaction latency) ---");
    const ageOrder = ["age:<10s", "age:10-60s", "age:1-5m", "age:5-30m", "age:>30m", "age:unknown"];
    const byAge = groupBy(trades, (t) => ageBucket(t.ageSec));
    for (const k of ageOrder) {
      const v = byAge.get(k);
      if (v && v.length) console.log(summarise(k, v));
    }
  }

  // B2 — persist this run + show the OOS trend across the Phase 2 wait.
  if (trades.length > 0) {
    const m = metricsOf(trades);
    const byReason: Record<string, number> = {};
    for (const [k, v] of groupBy(trades, (t) => t.reason)) byReason[k] = metricsOf(v).mean;
    const byAge: Record<string, number> = {};
    for (const [k, v] of groupBy(trades, (t) => ageBucket(t.ageSec))) byAge[k] = metricsOf(v).mean;
    await getDb().insert(evalRuns).values({
      windowStart: trades[0]!.closedAt,
      windowEnd: trades.at(-1)!.closedAt,
      trades: m.n,
      winRate: m.winRate,
      meanRet: m.mean,
      oosSharpe: m.sharpe,
      tailLossP95: m.tailP95,
      totalPnlSol: m.totalPnl,
      byReason,
      byAge,
    });

    const hist = await getDb().execute(sql`
      SELECT ran_at, trades, oos_sharpe::float8 AS sharpe,
        tail_loss_p95::float8 AS tail, total_pnl_sol::float8 AS pnl
      FROM eval_runs ORDER BY ran_at DESC LIMIT 8
    `);
    const hrows = (
      hist as unknown as {
        rows: Array<{ ran_at: Date | string; trades: number; sharpe: number | null; tail: number | null; pnl: number | null }>;
      }
    ).rows;
    if (hrows.length > 1) {
      console.log("\n--- Eval-run history (most recent first) ---");
      for (const h of hrows) {
        const when = (h.ran_at instanceof Date ? h.ran_at : new Date(h.ran_at)).toISOString().slice(0, 16);
        console.log(
          `  ${when}  n=${String(h.trades).padStart(4)}  sharpe=${(h.sharpe ?? 0).toFixed(3).padStart(7)}  tailP95=${((h.tail ?? 0) * 100).toFixed(1).padStart(7)}%  pnl=${(h.pnl ?? 0).toFixed(4).padStart(9)} SOL`,
        );
      }
    }
  }

  const counts = await fetchMeasurementCounts();
  console.log("\n=== Measurement backbone (Phase 1) ===");
  console.log(
    `  feature_snapshots: universe=${counts.snapshotsUniverse}  control=${counts.snapshotsControl}`,
  );
  console.log(
    `  outcome_labels:    complete=${counts.labelsComplete}  pending=${counts.labelsPending}`,
  );
  console.log(
    "\nReminder: judge on OOS risk-adjusted return across a full meta shift — not hit rate.\n",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("eval-paper failed:", e);
  process.exit(1);
});
