/**
 * T3.1 — Genesis out-of-sample validation.
 *
 * THE PROBLEM (per v2 plan): the existing genesis backtest (SYSTEM_DESIGN.md
 * §III.3.4) was derived AND validated on the same 3-day window. That's the
 * in-sample trap Part II explicitly warns against, and the +1600% headline
 * was dominated by a handful of vSol≈1 outliers. Until we re-validate on a
 * window the gates haven't seen, we don't know if the edge is real.
 *
 * THIS SCRIPT: takes the CURRENT genesis gates (DEFAULT_GENESIS_CONFIG, locked
 * at the build time on 2026-06-15) and replays them against TEST data — mints
 * created in a window AFTER those gates were set. Uses T0.3 honest slippage on
 * BOTH entry AND exit. Reports MEDIAN return (not mean — outliers), with
 * bootstrap CIs on the edge over a random-baseline. PASS requires the CI to
 * exclude zero, per the kill-gate's bootstrap rule.
 *
 * Read-only. No DB writes, no live execution.
 */

import { bootDb, getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { evaluateGenesisSnipe, type GenesisSignal } from "@/lib/intelligence/genesis-snipe";
import { applySlippage } from "@spr/trading";

// Window split: TRAIN = mints created [now-6d, now-3d], TEST = [now-3d, now].
// Genesis gates were derived 2026-06-15 on a 3-day window, so anything created
// AFTER that is OOS for those gates. We use 6 days back to ensure enough data;
// EVENT_RETENTION_DAYS=7 means anything older is already pruned.
const TRAIN_DAYS_AGO_START = 6;
const TRAIN_DAYS_AGO_END = 3;
const TEST_DAYS_AGO_START = 3;
const TEST_DAYS_AGO_END = 0;

const POSITION_SIZE_SOL = 0.02;       // GENESIS_SNIPER_SIZE_SOL default
const MAX_HOLD_SEC = 300;             // 5min — matches genesis plan T3.3 hint
const BOOTSTRAP_ITERATIONS = 2000;
const RANDOM_SEED = 1337;

// ---------- types ----------

type MintCreate = { mint: string; createTs: Date };
type CurveEvent = { ts: Date; kind: "buy" | "sell"; wallet: string | null; solAmount: number; vSolAfter: number | null };

type CapturedTrade = {
  mint: string;
  fireTs: Date;
  fireVSol: number;
  effectiveEntryVSol: number;     // after honest slippage
  exitTs: Date;
  exitVSol: number;
  effectiveExitVSol: number;      // after honest slippage
  returnPct: number;              // net of slippage, on full position; (exit/entry)^2 - 1
  /** Max vSol reached during the hold window (max-favorable-excursion). */
  peakVSol: number;
  /** Return at the peak, with entry slippage but assuming we COULD exit at peak with same slippage rules. */
  peakReturnPct: number;
};

// ---------- DB helpers ----------

async function fetchMintCreates(daysAgoStart: number, daysAgoEnd: number): Promise<MintCreate[]> {
  const res = await getDb().execute(sql`
    SELECT mint::text AS mint, ts AS create_ts FROM events
    WHERE kind = 'create'
      AND ts >  now() - (${daysAgoStart} || ' days')::interval
      AND ts <= now() - (${daysAgoEnd} || ' days')::interval
    ORDER BY ts ASC
  `);
  type Row = { mint: string; create_ts: Date | string };
  return (res as unknown as { rows: Row[] }).rows.map((r) => ({
    mint: r.mint,
    createTs: r.create_ts instanceof Date ? r.create_ts : new Date(r.create_ts),
  }));
}

async function fetchCurveEvents(mint: string, fromTs: Date, toTs: Date): Promise<CurveEvent[]> {
  const res = await getDb().execute(sql`
    SELECT ts, kind::text AS kind, wallet::text AS wallet,
           COALESCE(sol_amount, 0)::float8 AS sol_amount,
           v_sol_after::float8 AS v_sol_after
    FROM events
    WHERE mint = ${mint}
      AND kind IN ('buy', 'sell')
      AND ts >= ${fromTs.toISOString()}::timestamptz
      AND ts <= ${toTs.toISOString()}::timestamptz
    ORDER BY ts ASC
  `);
  type Row = { ts: Date | string; kind: string; wallet: string | null; sol_amount: number; v_sol_after: number | null };
  return (res as unknown as { rows: Row[] }).rows.map((r) => ({
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts),
    kind: r.kind as "buy" | "sell",
    wallet: r.wallet,
    solAmount: r.sol_amount,
    vSolAfter: r.v_sol_after,
  }));
}

// ---------- replay engine ----------

/**
 * Walk a mint's first 90s of curve events; at each event ts ≥ createTs+5s,
 * build the live GenesisSignal as-of-now and evaluate the genesis gate. The
 * first fire is our entry; we then walk forward up to MAX_HOLD_SEC to find
 * the realized exit vSol. Slippage is applied to BOTH legs.
 */
function replayAndCapture(create: MintCreate, events: CurveEvent[]): CapturedTrade | null {
  const createMs = create.createTs.getTime();
  const maxEvalMs = createMs + 90_000;
  const initialVSol = events.find((e) => e.vSolAfter != null && e.vSolAfter > 0)?.vSolAfter ?? null;

  // ---- find fire ----
  let fireIdx = -1;
  let fireVSol = 0;
  for (let i = 0; i < events.length; i++) {
    const evtMs = events[i]!.ts.getTime();
    const ageSec = (evtMs - createMs) / 1000;
    if (ageSec < 5) continue;
    if (evtMs > maxEvalMs) break;

    const windowFromMs = evtMs - 30_000;
    let buys30 = 0, sells30 = 0, buyVol = 0, sellVol = 0;
    const buyers = new Set<string>();
    for (let j = 0; j <= i; j++) {
      const e = events[j]!;
      const eMs = e.ts.getTime();
      if (eMs < windowFromMs) continue;
      if (eMs > evtMs) break;
      if (e.kind === "buy") { buys30++; buyVol += e.solAmount; if (e.wallet) buyers.add(e.wallet); }
      else { sells30++; sellVol += e.solAmount; }
    }
    const currentVSol = events[i]!.vSolAfter ?? initialVSol;
    if (currentVSol == null || currentVSol <= 0) continue;

    const signal: GenesisSignal = {
      mint: create.mint, ageSec, currentVSol, initialVSol,
      buys30s: buys30, sells30s: sells30, uniqueBuyers30s: buyers.size,
      buyVolSol30s: buyVol, sellVolSol30s: sellVol,
    };
    if (evaluateGenesisSnipe(signal).fire) {
      fireIdx = i;
      fireVSol = currentVSol;
      break;
    }
  }
  if (fireIdx === -1) return null;

  // ---- apply entry slippage ----
  const fireTs = events[fireIdx]!.ts;
  const fireMs = fireTs.getTime();
  const entrySlip = applySlippage({
    side: "BUY",
    quotePrice: fireVSol,
    notionalSol: POSITION_SIZE_SOL,
    referenceVSol: fireVSol,
  });
  const effectiveEntryVSol = entrySlip.fillPrice;

  // ---- find exit vSol at fireTs + MAX_HOLD_SEC AND peak vSol in the same window ----
  const exitDeadlineMs = fireMs + MAX_HOLD_SEC * 1000;
  let exitTs = fireTs;
  let exitVSol = fireVSol;
  let peakVSol = fireVSol;
  for (let i = fireIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.ts.getTime() > exitDeadlineMs) break;
    if (e.vSolAfter == null || e.vSolAfter <= 0) continue;
    exitTs = e.ts;
    exitVSol = e.vSolAfter;
    if (e.vSolAfter > peakVSol) peakVSol = e.vSolAfter;
  }

  // ---- apply exit slippage (held to deadline) ----
  const exitSlip = applySlippage({ side: "SELL", quotePrice: exitVSol, notionalSol: POSITION_SIZE_SOL, referenceVSol: exitVSol });
  const effectiveExitVSol = exitSlip.fillPrice;
  // Curve value PnL = (exit/entry)^2 - 1
  const returnPct = (effectiveExitVSol / effectiveEntryVSol) ** 2 - 1;

  // Peak return diagnostic: what we COULD have realized if exit policy caught the
  // max-favorable-excursion exactly. Slippage applied to the peak as if we sold there.
  const peakSlip = applySlippage({ side: "SELL", quotePrice: peakVSol, notionalSol: POSITION_SIZE_SOL, referenceVSol: peakVSol });
  const peakReturnPct = (peakSlip.fillPrice / effectiveEntryVSol) ** 2 - 1;

  return { mint: create.mint, fireTs, fireVSol, effectiveEntryVSol, exitTs, exitVSol, effectiveExitVSol, returnPct, peakVSol, peakReturnPct };
}

/** Random baseline: pretend we entered at a uniformly-sampled tradeable moment in the same 5-60s window. */
function captureRandomBaseline(create: MintCreate, events: CurveEvent[], rand: () => number): CapturedTrade | null {
  const createMs = create.createTs.getTime();
  const eligibleIdxs: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const evtMs = events[i]!.ts.getTime();
    const ageSec = (evtMs - createMs) / 1000;
    if (ageSec < 5 || ageSec > 60) continue;
    const v = events[i]!.vSolAfter;
    if (v == null || v <= 0) continue;
    eligibleIdxs.push(i);
  }
  if (eligibleIdxs.length === 0) return null;
  const idx = eligibleIdxs[Math.floor(rand() * eligibleIdxs.length)]!;
  const fireTs = events[idx]!.ts;
  const fireVSol = events[idx]!.vSolAfter!;
  const entrySlip = applySlippage({ side: "BUY", quotePrice: fireVSol, notionalSol: POSITION_SIZE_SOL, referenceVSol: fireVSol });
  const exitDeadlineMs = fireTs.getTime() + MAX_HOLD_SEC * 1000;
  let exitTs = fireTs, exitVSol = fireVSol, peakVSol = fireVSol;
  for (let i = idx + 1; i < events.length; i++) {
    if (events[i]!.ts.getTime() > exitDeadlineMs) break;
    if (events[i]!.vSolAfter == null || events[i]!.vSolAfter! <= 0) continue;
    exitTs = events[i]!.ts; exitVSol = events[i]!.vSolAfter!;
    if (events[i]!.vSolAfter! > peakVSol) peakVSol = events[i]!.vSolAfter!;
  }
  const exitSlip = applySlippage({ side: "SELL", quotePrice: exitVSol, notionalSol: POSITION_SIZE_SOL, referenceVSol: exitVSol });
  const returnPct = (exitSlip.fillPrice / entrySlip.fillPrice) ** 2 - 1;
  const peakSlip = applySlippage({ side: "SELL", quotePrice: peakVSol, notionalSol: POSITION_SIZE_SOL, referenceVSol: peakVSol });
  const peakReturnPct = (peakSlip.fillPrice / entrySlip.fillPrice) ** 2 - 1;
  return { mint: create.mint, fireTs, fireVSol, effectiveEntryVSol: entrySlip.fillPrice, exitTs, exitVSol, effectiveExitVSol: exitSlip.fillPrice, returnPct, peakVSol, peakReturnPct };
}

// ---------- statistics ----------

// Seeded LCG for reproducibility
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function percentile(arr: number[], q: number): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
function mean(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function bootstrapMedianDiffCI(a: number[], b: number[], iters: number, rng: () => number, ciAlpha = 0.05): { lo: number; hi: number; pointEstimate: number } {
  const diffs: number[] = [];
  for (let i = 0; i < iters; i++) {
    const aResamp = Array.from({ length: a.length }, () => a[Math.floor(rng() * a.length)]!);
    const bResamp = Array.from({ length: b.length }, () => b[Math.floor(rng() * b.length)]!);
    diffs.push(median(aResamp)! - median(bResamp)!);
  }
  diffs.sort((a, b) => a - b);
  const lo = diffs[Math.floor((ciAlpha / 2) * diffs.length)]!;
  const hi = diffs[Math.floor((1 - ciAlpha / 2) * diffs.length)]!;
  return { lo, hi, pointEstimate: median(a)! - median(b)! };
}

// ---------- main ----------

async function evaluateWindow(label: string, daysAgoStart: number, daysAgoEnd: number, rng: () => number) {
  console.log(`\n----- ${label}: mints created [now-${daysAgoStart}d, now-${daysAgoEnd}d] -----`);
  const creates = await fetchMintCreates(daysAgoStart, daysAgoEnd);
  console.log(`  ${creates.length} mints created in this window`);

  const genesisTrades: CapturedTrade[] = [];
  const randomTrades: CapturedTrade[] = [];
  let processed = 0;
  for (const c of creates) {
    const winEnd = new Date(c.createTs.getTime() + 6 * 60_000); // 6min: enough for 60s fire + 5min hold
    const evts = await fetchCurveEvents(c.mint, c.createTs, winEnd);
    const g = replayAndCapture(c, evts);
    if (g) genesisTrades.push(g);
    const r = captureRandomBaseline(c, evts, rng);
    if (r) randomTrades.push(r);
    processed++;
    if (processed % 2000 === 0) console.log(`  ... processed ${processed}/${creates.length}`);
  }

  const gReturns = genesisTrades.map((t) => t.returnPct);
  const rReturns = randomTrades.map((t) => t.returnPct);
  const gPeaks = genesisTrades.map((t) => t.peakReturnPct);
  const rPeaks = randomTrades.map((t) => t.peakReturnPct);

  console.log(`  GENESIS fired: ${genesisTrades.length} (${((100 * genesisTrades.length) / Math.max(1, creates.length)).toFixed(2)}%)`);
  console.log(`  Random baseline drawn: ${randomTrades.length}`);
  if (genesisTrades.length === 0) {
    console.log("  No genesis fires — cannot evaluate this window.");
    return null;
  }

  const winPct = (xs: number[]) => xs.length === 0 ? null : (100 * xs.filter((x) => x > 0).length) / xs.length;
  console.log(`\n  HELD-TO-DEADLINE (no trail-stop, strawman exit; ${POSITION_SIZE_SOL} SOL position, ${MAX_HOLD_SEC}s max hold):`);
  console.log(`    GENESIS  median=${(median(gReturns)! * 100).toFixed(2)}%  mean=${(mean(gReturns)! * 100).toFixed(2)}%  p25=${(percentile(gReturns, 0.25)! * 100).toFixed(2)}%  p75=${(percentile(gReturns, 0.75)! * 100).toFixed(2)}%  win=${winPct(gReturns)?.toFixed(1)}%`);
  console.log(`    RANDOM   median=${(median(rReturns)! * 100).toFixed(2)}%  mean=${(mean(rReturns)! * 100).toFixed(2)}%  p25=${(percentile(rReturns, 0.25)! * 100).toFixed(2)}%  p75=${(percentile(rReturns, 0.75)! * 100).toFixed(2)}%  win=${winPct(rReturns)?.toFixed(1)}%`);

  console.log(`\n  PEAK-CAPTURE (max-favorable-excursion in the hold window — best case exit):`);
  console.log(`    GENESIS  median=${(median(gPeaks)! * 100).toFixed(2)}%  mean=${(mean(gPeaks)! * 100).toFixed(2)}%  p25=${(percentile(gPeaks, 0.25)! * 100).toFixed(2)}%  p75=${(percentile(gPeaks, 0.75)! * 100).toFixed(2)}%  win=${winPct(gPeaks)?.toFixed(1)}%`);
  console.log(`    RANDOM   median=${(median(rPeaks)! * 100).toFixed(2)}%  mean=${(mean(rPeaks)! * 100).toFixed(2)}%  p25=${(percentile(rPeaks, 0.25)! * 100).toFixed(2)}%  p75=${(percentile(rPeaks, 0.75)! * 100).toFixed(2)}%  win=${winPct(rPeaks)?.toFixed(1)}%`);

  // bootstrap median-edge CI — held to deadline (the pre-registered metric)
  const { lo, hi, pointEstimate } = bootstrapMedianDiffCI(gReturns, rReturns, BOOTSTRAP_ITERATIONS, rng);
  const ciExcludesZero = lo > 0 || hi < 0;
  console.log(`\n  Median edge (held-to-deadline; genesis − random), bootstrap 95% CI over ${BOOTSTRAP_ITERATIONS} iters:`);
  console.log(`    point estimate: ${(pointEstimate * 100).toFixed(2)}%`);
  console.log(`    95% CI:         [${(lo * 100).toFixed(2)}%, ${(hi * 100).toFixed(2)}%]`);
  console.log(`    CI excludes 0:  ${ciExcludesZero ? "YES ✓" : "NO ✗"}`);

  // bootstrap peak edge — diagnostic
  const peakBoot = bootstrapMedianDiffCI(gPeaks, rPeaks, BOOTSTRAP_ITERATIONS, rng);
  console.log(`\n  Median PEAK edge (best-case capture; genesis − random):`);
  console.log(`    point estimate: ${(peakBoot.pointEstimate * 100).toFixed(2)}%`);
  console.log(`    95% CI:         [${(peakBoot.lo * 100).toFixed(2)}%, ${(peakBoot.hi * 100).toFixed(2)}%]`);

  return { label, fired: genesisTrades.length, gReturns, rReturns, gPeaks, rPeaks, edge: pointEstimate, ciLo: lo, ciHi: hi, ciExcludesZero, peakEdge: peakBoot.pointEstimate, peakCiLo: peakBoot.lo, peakCiHi: peakBoot.hi };
}

async function main() {
  await bootDb();
  const rng = makeRng(RANDOM_SEED);

  console.log("========================================");
  console.log("  T3.1 — Genesis OOS Validation");
  console.log("========================================");
  console.log("Genesis gates: DEFAULT_GENESIS_CONFIG (locked 2026-06-15 on a 3-day window)");
  console.log("Position size: " + POSITION_SIZE_SOL + " SOL · Max hold: " + MAX_HOLD_SEC + "s");
  console.log("Slippage: T0.3 honest curve-impact model on BOTH entry and exit");
  console.log("Bootstrap: " + BOOTSTRAP_ITERATIONS + " iters, seed " + RANDOM_SEED);

  const train = await evaluateWindow("TRAIN (in-sample reference)", TRAIN_DAYS_AGO_START, TRAIN_DAYS_AGO_END, rng);
  const test = await evaluateWindow("TEST (OUT OF SAMPLE)", TEST_DAYS_AGO_START, TEST_DAYS_AGO_END, rng);

  console.log("\n========================================");
  console.log("  THE DECISIVE STAT — OOS edge over random");
  console.log("========================================");
  if (!test) {
    console.log("OOS window had no genesis fires — analysis inconclusive.");
    process.exit(0);
  }
  if (train) {
    console.log(`In-sample edge:   ${(train.edge * 100).toFixed(2)}%  95%CI [${(train.ciLo * 100).toFixed(2)}%, ${(train.ciHi * 100).toFixed(2)}%]`);
  }
  console.log(`Out-of-sample edge: ${(test.edge * 100).toFixed(2)}%  95%CI [${(test.ciLo * 100).toFixed(2)}%, ${(test.ciHi * 100).toFixed(2)}%]`);
  console.log("");
  // The HELD-TO-DEADLINE verdict is the strict pre-registered metric.
  if (test.ciExcludesZero && test.edge > 0) {
    console.log("✅ PASS (held-to-deadline) — OOS median edge > 0 with 95% CI excluding zero.");
    console.log("   Genesis gates retain edge even with the strawman exit policy.");
    console.log("   Recommendation: proceed to T3.3 (genesis-tuned exits) and T4 ablation.");
  } else if (test.ciExcludesZero && test.edge < 0) {
    console.log("❌ FAIL (held-to-deadline) — OOS median edge significantly NEGATIVE.");
    console.log("   With a strawman exit policy, genesis gates produce WORSE outcomes than random.");
    console.log("");
    console.log("   BUT the peak-capture diagnostic decides whether 'gates' or 'exits' is the problem:");
    if (test.peakEdge > 0.1 && test.peakCiLo > 0) {
      console.log(`   PEAK EDGE = +${(test.peakEdge * 100).toFixed(1)}% (CI [${(test.peakCiLo * 100).toFixed(1)}%, ${(test.peakCiHi * 100).toFixed(1)}%]) — STRONGLY POSITIVE.`);
      console.log("   Interpretation: the gates DO pick coins with real upside, but the exit policy");
      console.log("   never captures it. The failure is the EXIT MODEL, not the entry selection.");
      console.log("   This is exactly the 'trail captures 23% of peak' pattern from session 31.");
      console.log("   Recommendation: T3.3 (genesis-tuned exits — laddered TP, tight rug-stop) becomes");
      console.log("   CRITICAL, not optional. The kill-gate vote should wait for T3.3 + a paper");
      console.log("   session with the real exit policy before declaring the gate dead.");
    } else if (test.peakEdge > 0 && !test.ciExcludesZero) {
      console.log(`   PEAK EDGE = +${(test.peakEdge * 100).toFixed(1)}% (CI includes zero) — mildly positive but noisy.`);
      console.log("   Interpretation: gates may pick somewhat-better coins, but the upside is thin enough");
      console.log("   that even perfect exits wouldn't reliably beat random.");
      console.log("   Recommendation: gates need rework (re-derive thresholds on OOS), THEN T3.3.");
    } else {
      console.log(`   PEAK EDGE = ${(test.peakEdge * 100).toFixed(1)}% (CI [${(test.peakCiLo * 100).toFixed(1)}%, ${(test.peakCiHi * 100).toFixed(1)}%]).`);
      console.log("   Peak-capture edge also non-positive → gates pick high-variance dumpers, not winners.");
      console.log("   Recommendation: rework the gates (re-derive thresholds on OOS) before T3.3.");
    }
  } else {
    console.log("❌ INDETERMINATE — held-to-deadline OOS edge CI INCLUDES zero.");
    console.log("   Effect is within noise; cannot claim genesis has real edge over random.");
    console.log("   Recommendation: gather more OOS data and re-run, OR treat V1=V0 in T4.");
  }

  process.exit(0);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
