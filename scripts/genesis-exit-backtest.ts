/**
 * T3.3a — Backtest candidate genesis exit policies against OOS fires.
 *
 * T3.1 proved the genesis GATES pick coins with real upside (peak +36.5% median,
 * CI [+25.8%,+51.4%]) but the strawman "hold 5min, no trail" exit captures none.
 * This finds the exit ladder that captures the most, replaying each fire's actual
 * post-entry vSol trajectory through candidate policies with T0.3 honest slippage
 * + the quadratic curve PnL basis. Read-only.
 */
import { bootDb, getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { evaluateGenesisSnipe, type GenesisSignal } from "@/lib/intelligence/genesis-snipe";
import { applySlippage } from "@spr/trading";

const TEST_DAYS_AGO_START = 3;
const TEST_DAYS_AGO_END = 0; // OOS window (same as T3.1 TEST)
const POSITION_SIZE_SOL = 0.02;
const MAX_HOLD_SEC = 300;

type CurveEvent = { ts: Date; kind: "buy" | "sell"; wallet: string | null; solAmount: number; vSolAfter: number | null };
type Fire = { mint: string; fireMs: number; entryVSol: number; effEntry: number; traj: Array<{ tMs: number; v: number }> };

async function q(s: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return getDb().execute(s).then((r: unknown) => (r as { rows: Array<Record<string, unknown>> }).rows);
}

async function fetchMintCreates(d0: number, d1: number) {
  return q(sql`SELECT mint::text AS mint, ts AS create_ts FROM events
    WHERE kind='create' AND ts > now() - (${d0} || ' days')::interval AND ts <= now() - (${d1} || ' days')::interval`);
}

async function fetchEvents(mint: string, from: Date, to: Date): Promise<CurveEvent[]> {
  const rows = await q(sql`SELECT ts, kind::text AS kind, wallet::text AS wallet,
    COALESCE(sol_amount,0)::float8 AS sol_amount, v_sol_after::float8 AS v_sol_after
    FROM events WHERE mint=${mint} AND kind IN ('buy','sell') AND venue='curve'
      AND ts>=${from.toISOString()}::timestamptz AND ts<=${to.toISOString()}::timestamptz ORDER BY ts ASC`);
  return rows.map((r) => ({
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts as string),
    kind: r.kind as "buy" | "sell",
    wallet: r.wallet as string | null,
    solAmount: r.sol_amount as number,
    vSolAfter: r.v_sol_after as number | null,
  }));
}

function detectFire(createMs: number, events: CurveEvent[]): Fire | null {
  const initialVSol = events.find((e) => e.vSolAfter != null && e.vSolAfter > 0)?.vSolAfter ?? null;
  for (let i = 0; i < events.length; i++) {
    const evtMs = events[i]!.ts.getTime();
    const age = (evtMs - createMs) / 1000;
    if (age < 5) continue;
    if (evtMs > createMs + 90_000) break;
    const wFrom = evtMs - 30_000;
    let b = 0, s = 0, bv = 0, sv = 0;
    const buyers = new Set<string>();
    for (let j = 0; j <= i; j++) {
      const e = events[j]!;
      const m = e.ts.getTime();
      if (m < wFrom) continue;
      if (m > evtMs) break;
      if (e.kind === "buy") { b++; bv += e.solAmount; if (e.wallet) buyers.add(e.wallet); }
      else { s++; sv += e.solAmount; }
    }
    const cur = events[i]!.vSolAfter ?? initialVSol;
    if (cur == null || cur <= 0) continue;
    const sig: GenesisSignal = {
      mint: "", ageSec: age, currentVSol: cur, initialVSol,
      buys30s: b, sells30s: s, uniqueBuyers30s: buyers.size, buyVolSol30s: bv, sellVolSol30s: sv,
    };
    if (evaluateGenesisSnipe(sig).fire) {
      const effEntry = applySlippage({ side: "BUY", quotePrice: cur, notionalSol: POSITION_SIZE_SOL, referenceVSol: cur }).fillPrice;
      const traj: Array<{ tMs: number; v: number }> = [];
      const deadline = evtMs + MAX_HOLD_SEC * 1000;
      for (let k = i + 1; k < events.length; k++) {
        const e = events[k]!;
        if (e.ts.getTime() > deadline) break;
        if (e.vSolAfter == null || e.vSolAfter <= 0) continue;
        traj.push({ tMs: e.ts.getTime(), v: e.vSolAfter });
      }
      return { mint: "", fireMs: evtMs, entryVSol: cur, effEntry, traj };
    }
  }
  return null;
}

type Policy = { name: string; run: (f: Fire) => number };

/** Realized return of selling `frac` of the position at exitVSol — curve quadratic, honest slippage. */
function sellRet(effEntry: number, exitVSol: number, frac: number): number {
  const effExit = applySlippage({ side: "SELL", quotePrice: exitVSol, notionalSol: POSITION_SIZE_SOL * frac, referenceVSol: exitVSol }).fillPrice;
  return frac * ((effExit / effEntry) ** 2 - 1);
}
function lastV(f: Fire): number {
  return f.traj.length ? f.traj[f.traj.length - 1]!.v : f.entryVSol;
}

function makePolicies(): Policy[] {
  const P: Policy[] = [];
  P.push({ name: "A strawman hold-5m", run: (f) => sellRet(f.effEntry, lastV(f), 1) });

  const slOnly = (slPct: number) => (f: Fire) => {
    const stop = f.entryVSol * (1 - slPct);
    for (const p of f.traj) if (p.v <= stop) return sellRet(f.effEntry, p.v, 1);
    return sellRet(f.effEntry, lastV(f), 1);
  };
  P.push({ name: "B SL-10% only", run: slOnly(0.10) });
  P.push({ name: "B SL-15% only", run: slOnly(0.15) });

  const trail = (armPct: number, trailPct: number, slPct: number) => (f: Fire) => {
    const stop = f.entryVSol * (1 - slPct);
    let armed = false, peak = f.entryVSol;
    for (const p of f.traj) {
      if (p.v <= stop) return sellRet(f.effEntry, p.v, 1);
      if (p.v > peak) peak = p.v;
      if (!armed && p.v >= f.entryVSol * (1 + armPct)) armed = true;
      if (armed && p.v <= peak * (1 - trailPct)) return sellRet(f.effEntry, p.v, 1);
    }
    return sellRet(f.effEntry, lastV(f), 1);
  };
  P.push({ name: "C trail arm15 stop8 SL12", run: trail(0.15, 0.08, 0.12) });
  P.push({ name: "C trail arm20 stop15 SL10", run: trail(0.20, 0.15, 0.10) });
  P.push({ name: "C trail arm30 stop25 SL10", run: trail(0.30, 0.25, 0.10) });

  const ladder = (tp1: number, tp2: number, slPct: number, moonTrail: number) => (f: Fire) => {
    const stop = f.entryVSol * (1 - slPct);
    let r = 0, open = 1, t1 = false, t2 = false, peak = f.entryVSol, moonArmed = false;
    for (const p of f.traj) {
      if (p.v > peak) peak = p.v;
      if (!t1 && p.v >= f.entryVSol * (1 + tp1)) { r += sellRet(f.effEntry, p.v, 0.5); open -= 0.5; t1 = true; }
      else if (t1 && !t2 && p.v >= f.entryVSol * (1 + tp2)) { r += sellRet(f.effEntry, p.v, 0.25); open -= 0.25; t2 = true; moonArmed = true; }
      else if (p.v <= stop && open > 0) { r += sellRet(f.effEntry, p.v, open); return r; }
      else if (moonArmed && open > 0 && p.v <= peak * (1 - moonTrail)) { r += sellRet(f.effEntry, p.v, open); return r; }
    }
    if (open > 0) r += sellRet(f.effEntry, lastV(f), open);
    return r;
  };
  P.push({ name: "D ladder 50@50/25@150/SL10/moon40", run: ladder(0.50, 1.50, 0.10, 0.40) });
  P.push({ name: "D ladder 50@30/25@100/SL10/moon35", run: ladder(0.30, 1.00, 0.10, 0.35) });
  P.push({ name: "D ladder 50@50/25@200/SL12/moon50", run: ladder(0.50, 2.00, 0.12, 0.50) });
  return P;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length || 1;
  const med = s[Math.floor(s.length / 2)] ?? 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const win = (100 * xs.filter((x) => x > 0).length) / n;
  return { med, mean, win };
}

async function main() {
  await bootDb();
  console.log("=== T3.3a — genesis exit-ladder backtest (OOS window) ===\n");
  const creates = await fetchMintCreates(TEST_DAYS_AGO_START, TEST_DAYS_AGO_END);
  console.log(`scanning ${creates.length} mints...`);
  const fires: Fire[] = [];
  let proc = 0;
  for (const c of creates) {
    const ct = c.create_ts instanceof Date ? c.create_ts : new Date(c.create_ts as string);
    const evts = await fetchEvents(c.mint as string, ct, new Date(ct.getTime() + 6 * 60_000));
    const f = detectFire(ct.getTime(), evts);
    if (f) { f.mint = c.mint as string; fires.push(f); }
    if (++proc % 500 === 0) console.log(`  ...${proc}/${creates.length} (${fires.length} fires)`);
  }
  const withTraj = fires.filter((f) => f.traj.length > 0);
  console.log(`\n${fires.length} genesis fires; ${withTraj.length} have post-entry trajectory\n`);

  const policies = makePolicies();
  console.log("Policy".padEnd(38) + "median%  mean%   win%   sumSOL");
  const results: Array<{ name: string; med: number; sum: number }> = [];
  for (const pol of policies) {
    const rets = withTraj.map((f) => pol.run(f));
    const st = stats(rets);
    const sumSol = rets.reduce((a, r) => a + r * POSITION_SIZE_SOL, 0);
    console.log(
      pol.name.padEnd(38) +
      (st.med * 100).toFixed(1).padStart(7) +
      (st.mean * 100).toFixed(1).padStart(8) +
      st.win.toFixed(0).padStart(7) +
      sumSol.toFixed(4).padStart(10),
    );
    results.push({ name: pol.name, med: st.med, sum: sumSol });
  }
  const bestMed = results.reduce((a, b) => (b.med > a.med ? b : a));
  const bestSum = results.reduce((a, b) => (b.sum > a.sum ? b : a));
  console.log(`\nBest by median realized: ${bestMed.name} (median ${(bestMed.med * 100).toFixed(1)}%)`);
  console.log(`Best by total SOL:       ${bestSum.name} (sum ${bestSum.sum.toFixed(4)})`);
  console.log("\nMedian is robust to moon outliers; sum captures the moonbag upside. Pick the ladder that lifts BOTH vs strawman (A).");
  process.exit(0);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
