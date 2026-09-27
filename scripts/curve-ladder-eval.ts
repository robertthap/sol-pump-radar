/**
 * Offline replication of the CURVE LADDER rule against our own `events` feed.
 *
 * The source specification reports this rule as a failure (-0.09% / -0.44% /
 * -0.37% excess vs matched random across three cost settings) and asks for
 * independent checking. This is that check, run on 7 days of our own curve
 * trades rather than the original dataset.
 *
 * THE CONTROL IS THE WHOLE POINT. The specification's own post-mortem is that
 * scoring the rule against an all-levels base rate made it look like 3.27x,
 * while matching on crossing level made it 1.09x — because condition 3 cannot
 * fire below level 30, so an unmatched control is measuring WHICH RUNG, not
 * whether the rule picks well. This script reports both numbers side by side so
 * the artefact is visible rather than described.
 *
 * Run: pnpm ladder-eval
 */
import { bootDb, getDb, getPool } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import {
  CURVE_LADDER_HOLD_SECONDS,
  GRADUATION_SOL,
  LADDER_LEVELS,
  isStandardCurveRow,
  ladderSignal,
  levelsCrossed,
  minRealSolGain120s,
  realSolFromVSol,
  unreachableLevels,
} from "@/lib/trade/curve-ladder";

/**
 * Round-trip cost on a 0.349 SOL curve order, from the specification's own
 * table: 2.5% / 3.6% / 5.9% for OPTIMISTIC / BASE / CONSERVATIVE. BASE is
 * 1.25% fee each side plus 25 bps adverse slippage, a 30 bps MEV proxy and the
 * order's own price impact.
 *
 * The MEV proxy is an assumption in the source, not a measurement. It is
 * reproduced here unchanged rather than tuned, because adjusting a cost until a
 * result survives is how a dead rule comes back to life.
 */
const COST = { OPTIMISTIC: 0.025, BASE: 0.036, CONSERVATIVE: 0.059 } as const;

type Trade = {
  ts: number;
  wallet: string | null;
  side: string | null;
  sol: number;
  vSol: number;
};

type Episode = {
  mint: string;
  level: number;
  fired: boolean;
  /** Which condition failed first, for the diagnostic breakdown. */
  blockedBy: "size" | "concentration" | "rate" | null;
  /** Net return at BASE cost, as a fraction of the order. */
  net: number;
  gross: number;
  graduated: boolean;
};

/** Value on a bonding curve scales as vSol squared (mcap = vSol^2 / CURVE_DIV). */
function valueReturn(entryVSol: number, exitVSol: number): number {
  const r = exitVSol / entryVSol;
  return r * r - 1;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** Features at one crossing, from trades strictly BEFORE it. */
function featuresAt(trades: Trade[], i: number, level: number) {
  const t = trades[i];
  const now = t.ts;

  // Largest buyer's share of buy SOL over the previous 30s.
  const byWallet = new Map<string, number>();
  let buyTotal = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (now - trades[j].ts > 30) break;
    if (trades[j].side !== "buy") continue;
    const w = trades[j].wallet ?? "?";
    byWallet.set(w, (byWallet.get(w) ?? 0) + trades[j].sol);
    buyTotal += trades[j].sol;
  }
  const buyerConcentration30s =
    buyTotal > 0 ? Math.max(...byWallet.values()) / buyTotal : null;

  // (progress now - progress 120s ago) / 120. Null when no trade 120s back:
  // a gap is DATA_UNAVAILABLE, never a zero.
  let past: Trade | null = null;
  for (let j = i - 1; j >= 0; j--) {
    if (now - trades[j].ts >= 120) { past = trades[j]; break; }
  }
  const progressRate120s =
    past == null
      ? null
      : (realSolFromVSol(t.vSol) / GRADUATION_SOL - realSolFromVSol(past.vSol) / GRADUATION_SOL) / 120;

  return { level, crossingTradeSol: t.sol, buyerConcentration30s, progressRate120s };
}

/** Exit at +31s, or at graduation, whichever comes first. */
function exitVSol(trades: Trade[], i: number): { vSol: number; graduated: boolean } {
  const deadline = trades[i].ts + CURVE_LADDER_HOLD_SECONDS;
  let out = trades[i].vSol;
  for (let j = i + 1; j < trades.length; j++) {
    if (realSolFromVSol(trades[j].vSol) >= GRADUATION_SOL) {
      return { vSol: trades[j].vSol, graduated: true };
    }
    if (trades[j].ts > deadline) break;
    out = trades[j].vSol;
  }
  return { vSol: out, graduated: false };
}

async function main() {
  await bootDb();

  console.log("CURVE LADDER — offline replication\n");
  console.log(`condition 3 needs a ${minRealSolGain120s().toFixed(2)} SOL gain in 120s`);
  console.log(`=> rungs that can never fire: ${unreachableLevels().join(", ")}\n`);

  // Only mints that got far enough up the curve to cross anything.
  const res = await getDb().execute(sql`
    WITH eligible AS (
      SELECT mint FROM events
      WHERE venue = 'curve' AND v_sol_after IS NOT NULL
      GROUP BY mint HAVING MAX(v_sol_after) - 30 >= 5
    )
    SELECT e.mint, extract(epoch FROM e.ts)::float8 AS ts, e.wallet, e.side,
           e.sol_amount::float8 AS sol, e.v_sol_after::float8 AS vsol
    FROM events e JOIN eligible g ON g.mint = e.mint
    WHERE e.venue = 'curve'
    ORDER BY e.mint, e.id
  `);

  const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  console.log(`pulled ${rows.length.toLocaleString()} curve trades\n`);

  // Group by mint, excluding rows outside the curve's arithmetic range. The
  // specification insists these are excluded AND COUNTED, never silently
  // dropped: a filter that quietly eats them hides venue mixing.
  const byMint = new Map<string, Trade[]>();
  let excluded = 0;
  for (const r of rows) {
    const vSol = r.vsol == null ? null : Number(r.vsol);
    const sol = r.sol == null ? null : Number(r.sol);
    if (!isStandardCurveRow(vSol, sol)) { excluded++; continue; }
    const m = String(r.mint);
    const list = byMint.get(m) ?? [];
    list.push({ ts: Number(r.ts), wallet: r.wallet == null ? null : String(r.wallet),
                side: r.side == null ? null : String(r.side), sol: sol!, vSol: vSol! });
    byMint.set(m, list);
  }
  console.log(`excluded ${excluded.toLocaleString()} rows outside the curve range ` +
              `(graduated coins priced off mcap, non-SOL-quoted curves)`);
  console.log(`${byMint.size.toLocaleString()} mints retained\n`);

  // Walk each mint, opening one episode per rung crossed.
  const episodes: Episode[] = [];
  for (const [mint, trades] of byMint) {
    const armed = new Set<number>();
    for (let i = 1; i < trades.length; i++) {
      const before = realSolFromVSol(trades[i - 1].vSol);
      const after = realSolFromVSol(trades[i].vSol);
      for (const level of levelsCrossed(before, after)) {
        if (armed.has(level)) continue;
        armed.add(level);
        const f = featuresAt(trades, i, level);
        const s = ladderSignal(f);
        const ex = exitVSol(trades, i);
        const gross = valueReturn(trades[i].vSol, ex.vSol);
        episodes.push({
          mint, level, fired: s.fire,
          blockedBy: s.fire ? null : !s.checks.crossingSize ? "size"
                   : !s.checks.concentration ? "concentration" : "rate",
          gross, net: gross - COST.BASE, graduated: ex.graduated,
        });
      }
    }
  }

  console.log(`${episodes.length.toLocaleString()} episodes (one per mint per rung)\n`);

  // ---- fire rate by rung: the deadness, measured rather than asserted --------
  console.log("FIRE RATE BY RUNG");
  console.log("rung   episodes    fired   rate     blocked by rate");
  for (const level of LADDER_LEVELS) {
    const at = episodes.filter((e) => e.level === level);
    if (at.length === 0) continue;
    const fired = at.filter((e) => e.fired).length;
    const byRate = at.filter((e) => e.blockedBy === "rate").length;
    console.log(
      `${String(level).padStart(4)}  ${String(at.length).padStart(9)}  ${String(fired).padStart(7)}  ` +
      `${(100 * fired / at.length).toFixed(1).padStart(5)}%  ${(100 * byRate / at.length).toFixed(1).padStart(14)}%`,
    );
  }

  // ---- what every rung is worth, regardless of the rule ---------------------
  // Worth its own panel: if the rungs the rule is confined to are the bad ones,
  // then the structural defect is not merely narrowing the rule, it is aiming it
  // at the worst part of the curve.
  console.log("\n\nRETURN BY RUNG — ALL EPISODES (the rule is irrelevant here)");
  console.log("rung   episodes      mean     median    % positive");
  for (const level of LADDER_LEVELS) {
    const at = episodes.filter((e) => e.level === level);
    if (at.length === 0) continue;
    const nets = at.map((e) => e.net);
    const posShare = (100 * nets.filter((n) => n > 0).length) / nets.length;
    console.log(
      `${String(level).padStart(4)}  ${String(at.length).padStart(9)}  ${pct(mean(nets)).padStart(9)}  ` +
      `${pct(median(nets)).padStart(9)}  ${posShare.toFixed(1).padStart(10)}%`,
    );
  }

  const fired = episodes.filter((e) => e.fired);
  if (fired.length === 0) {
    console.log("\nthe rule never fired — nothing further to score");
    await getPool().end();
    return;
  }

  // ---- the two comparisons, side by side ------------------------------------
  const notFired = episodes.filter((e) => !e.fired);

  console.log("\n\nCOMPARISON 1 — UNSTRATIFIED (the original mistake)");
  console.log("  every non-firing episode at every rung is the control");
  console.log(`  fired      n=${String(fired.length).padStart(6)}  mean ${pct(mean(fired.map((e) => e.net)))}  median ${pct(median(fired.map((e) => e.net)))}`);
  console.log(`  control    n=${String(notFired.length).padStart(6)}  mean ${pct(mean(notFired.map((e) => e.net)))}  median ${pct(median(notFired.map((e) => e.net)))}`);
  console.log(`  excess                    ${pct(mean(fired.map((e) => e.net)) - mean(notFired.map((e) => e.net)))}`);

  console.log("\nCOMPARISON 2 — MATCHED ON RUNG (the honest one)");
  console.log("  each fired episode is compared only against non-firing episodes at the SAME rung");
  console.log("rung      fired    mean     control      mean     excess");
  let wSum = 0, wN = 0;
  for (const level of LADDER_LEVELS) {
    const f = fired.filter((e) => e.level === level);
    const c = notFired.filter((e) => e.level === level);
    if (f.length === 0 || c.length === 0) continue;
    const ex = mean(f.map((e) => e.net)) - mean(c.map((e) => e.net));
    wSum += ex * f.length; wN += f.length;
    console.log(
      `${String(level).padStart(4)}  ${String(f.length).padStart(9)}  ${pct(mean(f.map((e) => e.net))).padStart(7)}  ` +
      `${String(c.length).padStart(10)}  ${pct(mean(c.map((e) => e.net))).padStart(8)}  ${pct(ex).padStart(9)}`,
    );
  }
  console.log(`\n  weighted excess, matched on rung: ${pct(wN ? wSum / wN : NaN)}`);

  // ---- tail panels: where a few lucky hits reveal themselves -----------------
  console.log("\n\nTAIL PANELS (fired episodes, matched excess recomputed after trimming)");
  console.log("  a rule carried by a handful of hits gets WORSE as the top tail is removed");
  for (const trim of [0, 0.01, 0.05, 0.1]) {
    const cut = (xs: Episode[]) => {
      const s = [...xs].sort((a, b) => a.net - b.net);
      return s.slice(0, Math.max(1, Math.floor(s.length * (1 - trim))));
    };
    let ws = 0, wn = 0;
    for (const level of LADDER_LEVELS) {
      const f = cut(fired.filter((e) => e.level === level));
      const c = cut(notFired.filter((e) => e.level === level));
      if (f.length === 0 || c.length === 0) continue;
      ws += (mean(f.map((e) => e.net)) - mean(c.map((e) => e.net))) * f.length;
      wn += f.length;
    }
    console.log(`  top ${String(Math.round(trim * 100)).padStart(2)}% removed:  excess ${pct(wn ? ws / wn : NaN)}`);
  }

  // ---- concentration: how many distinct pools carry the result --------------
  const mints = new Set(fired.map((e) => e.mint));
  console.log(`\n\nCLUSTERING`);
  console.log(`  ${fired.length} fired episodes across ${mints.size} distinct mints`);
  console.log(`  episodes on one mint share a price path, so the effective sample is nearer ${mints.size} than ${fired.length}`);

  console.log(`\n\nCOST SENSITIVITY (weighted excess is cost-free — this is the raw fired return)`);
  for (const [name, c] of Object.entries(COST)) {
    console.log(`  ${name.padEnd(13)} ${pct(mean(fired.map((e) => e.gross - c)))}`);
  }

  await getPool().end();
}

void main();
