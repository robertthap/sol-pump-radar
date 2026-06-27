/**
 * T4 — Subtractive ablation report (the decisive experiment).
 *
 * Runs every variant (V0..V6) over the SAME recorded universe population
 * (feature_snapshots + matured outcome_labels) and reports per-trade Sortino,
 * P95 tail loss, total return, win rate, median — plus adjacent deltas with
 * bootstrapped 95% CIs and a PASS/FAIL verdict against the pre-registered
 * kill-gate (SYSTEM_DESIGN §8). Offline + deterministic: same snapshots for
 * every variant → no time confound; recompute anytime.
 *
 * Answers:
 *   Q1 — does any variant clear the kill-gate?  (edge exists?)
 *   Q2 — is the complexity earning its keep?     (V6 vs the simpler rungs)
 *
 * CAVEAT on returns: outcome_labels has data-artifact outliers (tiny-refVSol
 * snapshots → (v/ref)² explodes; raw mean ret_1h ≈ 1e17). We CAP realized return
 * at [-1, +100] (−100%..+100×) — beyond +100× is uncapturable in practice
 * (no liquidity) and is almost always an artifact. A constant exit (1h hold) +
 * constant cap is held across ALL variants, so the comparison isolates ENTRY
 * selection (the Q2 question). Robust stats (median + capped Sortino) lead.
 */
import { bootDb, getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import {
  variantEnters,
  ALL_VARIANTS,
  ADJACENT_DELTAS,
  type AblationVariant,
  type AblationFeatures,
} from "@/lib/intelligence/ablation-router";

const RET_CAP_HI = 100; // +100× — practical capture ceiling; kills (v/ref)² artifacts
const RET_CAP_LO = -1; // −100%
const KILL_GATE_SORTINO = 0.7;
const KILL_GATE_MIN_N = 200;
const BOOTSTRAP_ITERS = 2000;
const SEED = 4242;
const NOTIONAL = 0.02;

type Row = { id: string; ms: Record<string, unknown> | null; ret1h: number; maxGain: number | null };

async function loadPopulation(): Promise<Array<{ id: string; feat: AblationFeatures; ret: number }>> {
  const res = await getDb().execute(sql`
    SELECT fs.id::text AS id, fs.features->'module_scores' AS ms,
      ol.ret_1h::float8 AS ret1h, ol.max_gain_pct::float8 AS max_gain
    FROM feature_snapshots fs JOIN outcome_labels ol ON ol.snapshot_id = fs.id
    WHERE fs.sample_source='universe' AND ol.ret_1h IS NOT NULL AND ol.blocked_reason IS NULL
  `);
  const rows = (res as unknown as { rows: Row[] }).rows;
  const num = (ms: Record<string, unknown> | null, k: string): number => {
    const v = ms?.[k];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
    return Number.isFinite(n) ? n : 0;
  };
  return rows.map((r) => ({
    id: r.id,
    feat: {
      intelligence: num(r.ms, "_intelligence"),
      rug: num(r.ms, "M3_RUG"),
      insider: num(r.ms, "M2_INSIDER"),
      wash: num(r.ms, "M5_WASH"),
      creator: num(r.ms, "M4_CREATOR"),
      grad: num(r.ms, "M1_GRADUATION"),
      engineA: num(r.ms, "_engine_a"),
      autoAllowed: num(r.ms, "_auto_trade_allowed"),
    },
    ret: Math.max(RET_CAP_LO, Math.min(RET_CAP_HI, r.ret1h)),
  }));
}

// ---- statistics ----
function makeRng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x1_0000_0000; }; }
function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; }
function mean(a: number[]): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function p05(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(0.05 * s.length)]!; }
/** Per-trade Sortino, τ=0 (the T0.2 / kill-gate formula). Downside dev over ALL trades. */
function sortino(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  const dd = Math.sqrt(mean(a.map((r) => Math.min(r, 0) ** 2)));
  return dd > 1e-9 ? m / dd : (m > 0 ? Infinity : 0);
}
function winRate(a: number[]): number { return a.length ? (100 * a.filter((r) => r > 0).length) / a.length : 0; }
function topShare(a: number[]): number {
  if (!a.length) return 0;
  const total = a.reduce((x, y) => x + y, 0);
  if (total <= 0) return 0;
  const max = Math.max(...a);
  return (100 * max) / total;
}

function bootstrapSortinoDiffCI(a: number[], b: number[], rng: () => number) {
  const diffs: number[] = [];
  for (let i = 0; i < BOOTSTRAP_ITERS; i++) {
    const ra = Array.from({ length: a.length }, () => a[Math.floor(rng() * a.length)]!);
    const rb = Array.from({ length: b.length }, () => b[Math.floor(rng() * b.length)]!);
    const sa = sortino(ra), sb = sortino(rb);
    if (Number.isFinite(sa) && Number.isFinite(sb)) diffs.push(sa - sb);
  }
  diffs.sort((x, y) => x - y);
  const lo = diffs[Math.floor(0.025 * diffs.length)] ?? 0;
  const hi = diffs[Math.floor(0.975 * diffs.length)] ?? 0;
  return { lo, hi, point: sortino(a) - sortino(b) };
}

async function main() {
  await bootDb();
  const rng = makeRng(SEED);
  console.log("==========================================");
  console.log("  T4 — Subtractive Ablation Report");
  console.log("==========================================");
  console.log(`returns capped to [${RET_CAP_LO}, +${RET_CAP_HI}] (artifact guard); 1h-hold exit held constant across variants\n`);

  const pop = await loadPopulation();
  console.log(`population: ${pop.length} labeled universe snapshots\n`);
  if (pop.length === 0) { console.log("No matured labels — nothing to evaluate."); process.exit(0); }

  type V = { variant: AblationVariant; rets: number[] };
  const byVariant: V[] = ALL_VARIANTS.map((variant) => ({
    variant,
    rets: pop.filter((p) => variantEnters(variant, p.feat, p.id)).map((p) => p.ret),
  }));

  console.log("Variant  n      win%   median%   sortino   p05(tail)   totalSOL   top1%");
  for (const v of byVariant) {
    const n = v.rets.length;
    const so = sortino(v.rets);
    const totalSol = v.rets.reduce((a, r) => a + r * NOTIONAL, 0);
    console.log(
      `${v.variant.padEnd(8)}${String(n).padStart(6)}  ${winRate(v.rets).toFixed(1).padStart(5)}  ${(median(v.rets) * 100).toFixed(2).padStart(8)}  ${(Number.isFinite(so) ? so.toFixed(3) : "inf").padStart(8)}  ${(p05(v.rets) * 100).toFixed(1).padStart(9)}  ${totalSol.toFixed(3).padStart(9)}  ${topShare(v.rets).toFixed(0).padStart(4)}`,
    );
  }

  console.log("\n--- Adjacent deltas (Sortino, bootstrapped 95% CI) ---");
  const get = (vr: AblationVariant) => byVariant.find((x) => x.variant === vr)!.rets;
  for (const d of ADJACENT_DELTAS) {
    const ci = bootstrapSortinoDiffCI(get(d.to), get(d.from), rng);
    const sig = ci.lo > 0 ? "HELPS ✓" : ci.hi < 0 ? "HURTS ✗" : "noise —";
    console.log(`  ${d.from}→${d.to}  Δsortino=${ci.point.toFixed(3)}  CI[${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]  ${sig}   (${d.isolates})`);
  }

  console.log("\n--- Kill-gate verdict (per variant) ---");
  let anyPass = false;
  for (const v of byVariant) {
    const n = v.rets.length;
    const so = sortino(v.rets);
    const total = v.rets.reduce((a, r) => a + r, 0);
    const pass = Number.isFinite(so) && so >= KILL_GATE_SORTINO && total > 0 && n >= KILL_GATE_MIN_N;
    if (pass) anyPass = true;
    const reasons: string[] = [];
    if (!(n >= KILL_GATE_MIN_N)) reasons.push(`n<${KILL_GATE_MIN_N}`);
    if (!(Number.isFinite(so) && so >= KILL_GATE_SORTINO)) reasons.push(`sortino<${KILL_GATE_SORTINO}`);
    if (!(total > 0)) reasons.push("total≤0");
    console.log(`  ${v.variant}: ${pass ? "PASS" : "FAIL"}${reasons.length ? "  (" + reasons.join(", ") + ")" : ""}`);
  }

  console.log("\n--- Q1 / Q2 ---");
  console.log(`Q1 (edge exists?): ${anyPass ? "at least one variant clears the kill-gate on this window" : "NO variant clears the kill-gate on this (partial) window"}`);
  const best = byVariant.reduce((a, b) => (sortino(b.rets) > sortino(a.rets) ? b : a));
  const v1 = get("V1"), v6 = get("V6");
  const v6v1 = bootstrapSortinoDiffCI(v6, v1, rng);
  console.log(`Q2 (complexity worth it?): best variant by Sortino = ${best.variant}. V6−V1 Δsortino CI [${v6v1.lo.toFixed(3)}, ${v6v1.hi.toFixed(3)}] → ${v6v1.lo > 0 ? "complexity HELPS" : v6v1.hi < 0 ? "complexity HURTS (simpler is better)" : "complexity is NOISE (V6≈V1 — the apparatus is cost without benefit)"}`);

  console.log("\nNOTE: this is a PRELIMINARY read on the partial label window (labels still maturing,");
  console.log("PumpSwap ingestion not yet on). The kill-gate's conclusive verdict needs the full");
  console.log("≥14-day window spanning a detected meta-shift (T1.3). Treat directionally.");
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
