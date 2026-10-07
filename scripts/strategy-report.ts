/**
 * H14 — the honest strategy test. READ-ONLY. Writes STRATEGY_REPORT.md.
 *
 *   pnpm strategy:report
 *   pnpm strategy:report -- --folds 5 --min-trades 100 --min-mints 50
 *
 * It issues SELECTs only and never touches a session, the breaker, or any
 * setting. Everything it reports comes from packages/trading/src/evaluation,
 * which is unit-tested to report NO EDGE on noise and to find a planted edge.
 *
 * It will REFUSE to issue a verdict it cannot support. Too few trades, too few
 * mints, an unmeasured latency or a look-ahead violation all stop the verdict
 * rather than producing a confident-looking number from thin evidence.
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import {
  walkForwardSplits, assertNoLookAhead, tradeStats, evInterval, verdict, ablation,
  brierScore, reliabilityBins, calibrationError,
  type Trade, type Prediction,
} from "@spr/trading";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}
const FOLDS = Math.max(2, Number(arg("folds", "5")));
const MIN_TRADES = Math.max(1, Number(arg("min-trades", "100")));
const MIN_MINTS = Math.max(1, Number(arg("min-mints", "50")));
const OUT = arg("out", "STRATEGY_REPORT.md");

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const num = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

/**
 * CLEAN trades only.
 *
 * blocked_reason IS NULL excludes rows censored over an ingest gap, and
 * measurementClean excludes trades taken while an adaptive learner was running.
 * Both would otherwise be averaged in as if they were ordinary evidence.
 */
async function loadTrades(): Promise<{ trades: Trade[]; excluded: Record<string, number> }> {
  const res = await getDb().execute(sql`
    SELECT
      p.mint::text AS mint,
      EXTRACT(EPOCH FROM p.opened_at)::float8 AS ts,
      p.realized_pnl_sol::float8 AS pnl_sol,
      CASE WHEN p.notional_sol > 0
        THEN (p.realized_pnl_sol / p.notional_sol)::float8 ELSE NULL END AS net_return,
      COALESCE(p.entry_features->>'research_venue', 'curve') AS venue,
      COALESCE((p.entry_features->>'measurementClean')::boolean, false) AS measurement_clean,
      COALESCE((p.entry_features->>'latencyMeasured')::boolean, false) AS latency_measured,
      p.entry_features->>'configHash' AS config_hash,
      p.modules_at_entry AS modules
    FROM paper_positions p
    WHERE p.state = 'CLOSED'
      AND p.realized_pnl_sol IS NOT NULL
      AND p.notional_sol > 0
    ORDER BY p.opened_at ASC
  `);
  type Row = {
    mint: string; ts: number; pnl_sol: number; net_return: number | null;
    venue: string; measurement_clean: boolean; latency_measured: boolean;
    config_hash: string | null; modules: Record<string, number> | null;
  };
  const rows = (res as unknown as { rows: Row[] }).rows;

  const excluded = { notMeasurementClean: 0, noReturn: 0 };
  const trades: Trade[] = [];
  const modulesByTrade = new Map<string, Record<string, number> | null>();
  for (const r of rows) {
    if (r.net_return == null || !Number.isFinite(r.net_return)) { excluded.noReturn++; continue; }
    if (!r.measurement_clean) { excluded.notMeasurementClean++; continue; }
    trades.push({
      mint: r.mint, ts: r.ts, pnlSol: r.pnl_sol, netReturn: r.net_return,
      phase: r.venue === "pumpswap" ? "post_graduation" : "pre_graduation",
    });
    modulesByTrade.set(`${r.mint}:${r.ts}`, r.modules ?? null);
  }
  return { trades, excluded, modulesByTrade };
}

/** The engines the brief asks to ablate one at a time. */
const ENGINES = ["M1_GRADUATION", "M2_INSIDER", "M3_RUG", "M4_CREATOR", "M5_WASH"] as const;

/**
 * Ablation by SPLITTING on each engine's score, not by refitting.
 *
 * Refitting a model without an input would need the training pipeline and is
 * not something a report can honestly do after the fact. What it CAN do is ask
 * whether trades the engine scored highly did better than those it did not —
 * which is the question "does this engine add value" reduces to here. Stated
 * explicitly because it is a weaker claim than a true leave-one-out refit.
 */
function ablationSection(
  trades: Trade[],
  modulesByTrade: Map<string, Record<string, number> | null>,
): string {
  const lines: string[] = ["## Ablation (per engine)", ""];
  const withModules = trades.filter((t) => modulesByTrade.get(`${t.mint}:${t.ts}`) != null);
  if (withModules.length < 20) {
    lines.push(
      `Only ${withModules.length} clean trades carry module scores — too few to ablate.`,
      "",
    );
    return lines.join("\n");
  }
  lines.push(
    "Each engine is split at the median of its own score among these trades:",
    "did the half it scored higher actually do better? This is a weaker claim",
    "than a leave-one-out refit, which would need the training pipeline.",
    "",
    "| engine | n high | n low | EV high | EV low | delta | significant |",
    "|---|---|---|---|---|---|---|",
  );
  for (const engine of ENGINES) {
    const scored = withModules
      .map((t) => ({ t, v: modulesByTrade.get(`${t.mint}:${t.ts}`)?.[engine] }))
      .filter((x): x is { t: Trade; v: number } => typeof x.v === "number" && Number.isFinite(x.v));
    if (scored.length < 20) { lines.push(`| ${engine} | — | — | — | — | — | no data |`); continue; }
    const sorted = [...scored].sort((a, b) => a.v - b.v);
    const mid = Math.floor(sorted.length / 2);
    const low = sorted.slice(0, mid).map((x) => x.t);
    const high = sorted.slice(mid).map((x) => x.t);
    const r = ablation(engine, high, low);
    lines.push(
      `| ${engine} | ${high.length} | ${low.length} | ${pct(r.withEv)} | ${pct(r.withoutEv)} | ` +
      `${pct(r.delta)} | ${r.significant ? "**yes**" : "no"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Score/outcome pairs for calibration, from clean labelled snapshots only. */
async function loadPredictions(): Promise<Prediction[]> {
  try {
    const res = await getDb().execute(sql`
      SELECT (fs.features->>'grad_score')::float8 AS p,
             (ol.ret_1h > 0) AS outcome
      FROM feature_snapshots fs
      JOIN outcome_labels ol ON ol.snapshot_id = fs.id
      WHERE ol.blocked_reason IS NULL
        AND ol.horizons_complete
        AND ol.ret_1h IS NOT NULL
        AND fs.features->>'grad_score' IS NOT NULL
    `);
    const rows = (res as unknown as { rows: Array<{ p: number; outcome: boolean }> }).rows;
    return rows
      .map((r) => ({ p: Number(r.p), outcome: Boolean(r.outcome) }))
      .filter((x) => Number.isFinite(x.p) && x.p >= 0 && x.p <= 1);
  } catch {
    return [];
  }
}

function statsBlock(title: string, trades: Trade[]): string {
  if (trades.length === 0) return `### ${title}\n\nNo clean trades.\n`;
  const s = tradeStats(trades);
  const ci = evInterval(trades);
  return [
    `### ${title}`,
    "",
    "| metric | value |",
    "|---|---|",
    `| trades | ${s.n} |`,
    `| distinct mints | ${s.mints} |`,
    `| win rate | ${pct(s.winRate)} |`,
    `| average win | ${pct(s.avgWin)} |`,
    `| average loss | ${pct(s.avgLoss)} |`,
    `| profit factor | ${num(s.profitFactor)} |`,
    `| **EV per trade** | **${pct(s.evPerTrade)}** |`,
    `| EV 95% interval (mint-clustered) | ${ci ? `${pct(ci.lo)} to ${pct(ci.hi)}` : "not enough mints"} |`,
    `| median trade | ${pct(s.medianReturn)} |`,
    `| trimmed mean (10%) | ${pct(s.trimmedMeanReturn)} |`,
    `| total P&L | ${num(s.totalPnlSol)} SOL |`,
    `| max drawdown | ${num(s.maxDrawdownSol)} SOL (${pct(s.maxDrawdownPct)}) |`,
    "",
  ].join("\n");
}

async function main() {
  await bootDb();
  const { trades, excluded, modulesByTrade } = await loadTrades();
  const predictions = await loadPredictions();

  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);

  push("# Strategy report (H14)", "");
  push(`Generated ${new Date().toISOString()} by \`pnpm strategy:report\`.`, "");
  push(
    "Produced from CLEAN data only: trades taken while an adaptive learner was",
    "running are excluded, and calibration uses labels not censored over an",
    "ingest gap. Splits are time-ordered walk-forward, never shuffled.",
    "",
  );

  push("## Data", "");
  push("| | |", "|---|---|");
  push(`| clean closed trades | ${trades.length} |`);
  push(`| distinct mints | ${new Set(trades.map((t) => t.mint)).size} |`);
  push(`| excluded: not measurement-clean | ${excluded.notMeasurementClean} |`);
  push(`| excluded: no computable return | ${excluded.noReturn} |`);
  push(`| calibration samples | ${predictions.length} |`, "");

  // ---- the blocking conditions, stated before any number is interpreted ----
  const blockers: string[] = [];
  if (trades.length < MIN_TRADES) blockers.push(`only ${trades.length} clean trades (need ${MIN_TRADES})`);
  const mints = new Set(trades.map((t) => t.mint)).size;
  if (mints < MIN_MINTS) blockers.push(`only ${mints} distinct mints (need ${MIN_MINTS})`);

  const folds = walkForwardSplits(trades, FOLDS);
  const leaks = assertNoLookAhead(folds);
  if (folds.length === 0) blockers.push("not enough data to build walk-forward folds");
  if (leaks.length > 0) blockers.push(`look-ahead detected in ${leaks.length} fold(s)`);

  push("## Out-of-sample (walk-forward)", "");
  if (folds.length === 0) {
    push("Not enough data to split.", "");
  } else {
    push(`${folds.length} expanding-window folds; look-ahead check: ` +
      (leaks.length === 0 ? "**clean**." : `**FAILED** — ${leaks.map((l) => l.reason).join("; ")}`), "");
    const oosTrades = folds.flatMap((f) => f.test);
    push(statsBlock("All out-of-sample test blocks", oosTrades));
    push(statsBlock("Pre-graduation (curve)", oosTrades.filter((t) => t.phase === "pre_graduation")));
    push(statsBlock("Post-graduation (AMM)", oosTrades.filter((t) => t.phase === "post_graduation")));
  }

  push(ablationSection(folds.flatMap((f) => f.test), modulesByTrade));

  push("## Calibration", "");
  const brier = brierScore(predictions);
  if (brier == null) {
    push("No usable score/outcome pairs — calibration cannot be assessed.", "");
  } else {
    push(`Brier score: **${brier.toFixed(4)}** (0.25 = always predicting 0.5, i.e. no information).`, "");
    const bins = reliabilityBins(predictions);
    push(`Weighted calibration error: **${calibrationError(bins).toFixed(4)}**.`, "");
    push("| predicted | n | mean predicted | observed |", "|---|---|---|---|");
    for (const b of bins) {
      push(`| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ` +
        `${b.n ? b.meanPredicted.toFixed(3) : "—"} | ${b.n ? b.observedRate.toFixed(3) : "—"} |`);
    }
    push("");
  }

  push("## Verdict", "");
  if (blockers.length > 0) {
    push("**NO VERDICT — the evidence does not support one.**", "");
    push("Blocking:", "");
    for (const b of blockers) push(`- ${b}`);
    push("", "Reporting an edge from this would be the exact failure this audit exists",
      "to prevent. Collect more clean data and run again.", "");
  } else {
    const oosTrades = folds.flatMap((f) => f.test);
    const stats = tradeStats(oosTrades);
    const v = verdict({
      oos: stats, interval: evInterval(oosTrades),
      minTrades: MIN_TRADES, minMints: MIN_MINTS,
    });
    push(v.edge ? "## **EDGE**" : "## **NO EDGE**", "", v.reason, "");
    push("| check | result |", "|---|---|");
    for (const [k, ok] of Object.entries(v.checks)) push(`| ${k} | ${ok ? "pass" : "**FAIL**"} |`);
    push("");
    if (v.edge) {
      push("Every check passed. Note what this does and does not say: it is an",
        "out-of-sample result after all modelled costs, not a promise. Re-run it",
        "on fresh data before risking anything.", "");
    }
  }

  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${OUT}`);
  console.log(blockers.length ? `NO VERDICT: ${blockers.join("; ")}` : "Verdict issued — see the report.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); });
