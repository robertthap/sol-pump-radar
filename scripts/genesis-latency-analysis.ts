/**
 * T3.2 — Genesis detection latency vs elite-wallet entry times.
 *
 * THE QUESTION (per v2 plan, Sprint 1b): elite wallets have a 22s median hold.
 * Our pipeline (WS → 500ms flush → 30s activity window → 3s commit → 3s
 * auto-trader) means realistic detection at second 30–45 after mint create.
 * If the elite wallet bought at second 2 and sold at second 24, we're buying
 * their exit AGAIN — just at vSol 40 instead of vSol 113. The genesis pivot
 * may not escape the exit-liquidity-provider role; it might just lower the
 * price tag of that role.
 *
 * THE METHOD: For each elite wallet's recent on-curve entries (vSol < 60),
 * replay our genesis gate against the same events table over the mint's first
 * minute, find when our gate would have fired, and compare to:
 *   - the elite wallet's entry timestamp
 *   - the elite wallet's exit timestamp (when known)
 *
 * THE DECISION (per the plan's pre-registered gate): if > 50% of cases have us
 * firing AFTER the elite's exit, the thesis needs rework — we'd still be exit
 * liquidity even at the better vSol price, just for a different cohort.
 *
 * Read-only — no DB writes, no live execution.
 */

import { bootDb, getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { evaluateGenesisSnipe, type GenesisSignal } from "@/lib/intelligence/genesis-snipe";

type EliteEntry = {
  wallet: string;
  mint: string;
  createTs: Date;
  eliteEntryTs: Date;
  eliteEntryVSol: number | null;
  eliteExitTs: Date | null;
  eliteHoldSec: number | null;
};

type CurveEvent = { ts: Date; kind: "buy" | "sell"; wallet: string | null; solAmount: number; vSolAfter: number | null };

type ReplayResult = {
  fireTs: Date | null;
  fireVSol: number | null;
  detectionLatencySec: number | null; // fire_ts - create_ts
  vsEliteEntrySec: number | null;     // fire_ts - elite_entry_ts (positive = behind)
  firedAfterEliteExit: boolean | null;
};

const ELITE_FILTER = sql`
  avg_return > 0.3
  AND t_stat >= 3
  AND NOT is_bump_bot
  AND COALESCE(bundle_rate, 0) < 0.5
  AND COALESCE(closed_mints, 0) >= 5
`;

async function fetchEliteEntries(walletLimit: number, entriesPerWallet: number): Promise<EliteEntry[]> {
  // Step 1: top elite wallets by t-stat.
  const wRes = await getDb().execute(sql`
    SELECT wallet::text AS wallet FROM wallet_profiles
    WHERE ${ELITE_FILTER}
    ORDER BY t_stat DESC
    LIMIT ${walletLimit}
  `);
  const wallets = (wRes as unknown as { rows: Array<{ wallet: string }> }).rows.map((r) => r.wallet);
  if (!wallets.length) return [];

  // Step 2: their recent on-curve entries (mints with a curve buy at vSol < 60).
  // SQL array binding via Drizzle fights the pg type system; build the IN-list
  // with sql.raw and escape each address. Solana addresses are base58 — only
  // [1-9A-HJ-NP-Za-km-z] — so the simple ' escape below is correct.
  const escaped = wallets.map((w) => `'${w.replace(/'/g, "''")}'`).join(",");
  const res = await getDb().execute(sql`
    WITH entries AS (
      SELECT
        e.wallet::text AS wallet,
        e.mint::text AS mint,
        (
          SELECT MIN(ts) FROM events e2
          WHERE e2.mint = e.mint AND e2.kind = 'create'
        ) AS create_ts,
        (
          SELECT MIN(ts) FROM events e3
          WHERE e3.mint = e.mint AND e3.wallet = e.wallet AND e3.kind = 'buy'
        ) AS elite_entry_ts,
        (
          SELECT v_sol_after::float8 FROM events e4
          WHERE e4.mint = e.mint AND e4.wallet = e.wallet AND e4.kind = 'buy'
          ORDER BY ts ASC LIMIT 1
        ) AS elite_entry_vsol,
        (
          SELECT MAX(ts) FROM events e5
          WHERE e5.mint = e.mint AND e5.wallet = e.wallet AND e5.kind = 'sell'
        ) AS elite_exit_ts
      FROM events e
      WHERE e.wallet IN (${sql.raw(escaped)})
        AND e.kind = 'buy'
        AND e.ts > now() - interval '14 days'
      GROUP BY e.wallet, e.mint
    )
    SELECT * FROM entries
    WHERE create_ts IS NOT NULL
      AND elite_entry_ts IS NOT NULL
      AND elite_entry_vsol IS NOT NULL
      AND elite_entry_vsol < 60
    ORDER BY wallet, elite_entry_ts DESC
  `);

  type Row = {
    wallet: string;
    mint: string;
    create_ts: Date | string;
    elite_entry_ts: Date | string;
    elite_entry_vsol: number;
    elite_exit_ts: Date | string | null;
  };
  const rows = (res as unknown as { rows: Row[] }).rows;
  const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

  // Take at most N most-recent entries per wallet (cheap dedup, the result is
  // already ordered DESC by elite_entry_ts within each wallet).
  const perWallet = new Map<string, EliteEntry[]>();
  for (const r of rows) {
    const wallet = r.wallet;
    const arr = perWallet.get(wallet) ?? [];
    if (arr.length >= entriesPerWallet) continue;
    const createTs = toDate(r.create_ts);
    const eliteEntryTs = toDate(r.elite_entry_ts);
    const eliteExitTs = r.elite_exit_ts ? toDate(r.elite_exit_ts) : null;
    arr.push({
      wallet,
      mint: r.mint,
      createTs,
      eliteEntryTs,
      eliteEntryVSol: r.elite_entry_vsol,
      eliteExitTs,
      eliteHoldSec: eliteExitTs
        ? (eliteExitTs.getTime() - eliteEntryTs.getTime()) / 1000
        : null,
    });
    perWallet.set(wallet, arr);
  }
  const out: EliteEntry[] = [];
  for (const arr of perWallet.values()) out.push(...arr);
  return out;
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
  const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
  return (res as unknown as { rows: Row[] }).rows.map((r) => ({
    ts: toDate(r.ts),
    kind: r.kind as "buy" | "sell",
    wallet: r.wallet,
    solAmount: r.sol_amount,
    vSolAfter: r.v_sol_after,
  }));
}

/**
 * Replay the genesis gate against this mint's first 90s. At every event
 * timestamp ≥ create_ts + 5s (the minAgeSec gate), build the signal as-of-now
 * (last 30s sliding window) and evaluate. The first fire is our detection ts.
 *
 * Reuses the LIVE evaluateGenesisSnipe — same code paths, same thresholds.
 * No future leakage: the sliding window only includes events with ts ≤ evalTs.
 */
function replayGenesisGate(entry: EliteEntry, events: CurveEvent[]): ReplayResult {
  const createMs = entry.createTs.getTime();
  const maxEvalMs = createMs + 90_000; // a hair beyond maxAgeSec=60 so border cases register

  // Initial vSol (earliest known) — used as priorVSol baseline by the velocity scorer.
  const initialVSol = events.find((e) => e.vSolAfter != null && e.vSolAfter > 0)?.vSolAfter ?? null;

  for (let i = 0; i < events.length; i++) {
    const evtMs = events[i]!.ts.getTime();
    const ageSec = (evtMs - createMs) / 1000;
    if (ageSec < 5) continue;          // below minAgeSec — gate would skip
    if (evtMs > maxEvalMs) break;       // past maxAgeSec — gate would skip too

    // Build the 30s sliding window ending at evtMs (inclusive)
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
      mint: entry.mint,
      ageSec,
      currentVSol,
      initialVSol,
      buys30s: buys30,
      sells30s: sells30,
      uniqueBuyers30s: buyers.size,
      buyVolSol30s: buyVol,
      sellVolSol30s: sellVol,
    };
    const dec = evaluateGenesisSnipe(signal);
    if (dec.fire) {
      const fireTs = events[i]!.ts;
      const detLat = (evtMs - createMs) / 1000;
      const vsEntry = (evtMs - entry.eliteEntryTs.getTime()) / 1000;
      const firedAfterExit = entry.eliteExitTs
        ? evtMs > entry.eliteExitTs.getTime()
        : null;
      return {
        fireTs,
        fireVSol: currentVSol,
        detectionLatencySec: detLat,
        vsEliteEntrySec: vsEntry,
        firedAfterEliteExit: firedAfterExit,
      };
    }
  }
  return { fireTs: null, fireVSol: null, detectionLatencySec: null, vsEliteEntrySec: null, firedAfterEliteExit: null };
}

function pct(arr: number[], q: number): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

async function main() {
  await bootDb();

  const WALLET_LIMIT = 40;       // top N elite wallets by t-stat
  const ENTRIES_PER_WALLET = 15; // most recent on-curve entries per wallet
  console.log(`[T3.2] Pulling elite wallets (filter: avg_return>0.3 AND t_stat>=3 AND closed_mints>=5 AND bundle<0.5) ...`);
  console.log(`[T3.2] Limits: ${WALLET_LIMIT} wallets × ${ENTRIES_PER_WALLET} entries each, last 14 days`);

  const entries = await fetchEliteEntries(WALLET_LIMIT, ENTRIES_PER_WALLET);
  console.log(`[T3.2] Found ${entries.length} elite on-curve entries (vSol<60) to replay`);
  if (!entries.length) {
    console.log("[T3.2] No elite entries to analyze. Either no elite wallets meet criteria, or none have on-curve entries in last 14d.");
    process.exit(0);
  }

  const results: Array<{ entry: EliteEntry; result: ReplayResult }> = [];
  let processed = 0;
  for (const e of entries) {
    const winEnd = new Date(e.createTs.getTime() + 90_000);
    const evts = await fetchCurveEvents(e.mint, e.createTs, winEnd);
    const r = replayGenesisGate(e, evts);
    results.push({ entry: e, result: r });
    processed++;
    if (processed % 50 === 0) console.log(`[T3.2]   ... processed ${processed}/${entries.length}`);
  }

  // ----- AGGREGATES -----
  const fired = results.filter((x) => x.result.fireTs !== null);
  const detLats = fired.map((x) => x.result.detectionLatencySec!);
  const vsEntries = fired.map((x) => x.result.vsEliteEntrySec!);

  // Cases where we have a known elite exit and we fired
  const withExit = fired.filter((x) => x.result.firedAfterEliteExit !== null);
  const firedAfterExit = withExit.filter((x) => x.result.firedAfterEliteExit === true);

  // Elite hold-time distribution for context
  const eliteHolds = entries.filter((e) => e.eliteHoldSec != null).map((e) => e.eliteHoldSec!);

  console.log("\n========================================");
  console.log("  T3.2 — Genesis Latency vs Elite Entry");
  console.log("========================================");
  console.log(`Total elite entries analyzed:      ${entries.length}`);
  console.log(`Genesis gate would FIRE:           ${fired.length} (${((100 * fired.length) / entries.length).toFixed(1)}%)`);
  console.log(`Genesis gate would NOT fire:       ${entries.length - fired.length}`);
  if (eliteHolds.length) {
    console.log(`\nElite hold-time (closed only, n=${eliteHolds.length}):`);
    console.log(`  median: ${pct(eliteHolds, 0.5)?.toFixed(1)}s   p25: ${pct(eliteHolds, 0.25)?.toFixed(1)}s   p75: ${pct(eliteHolds, 0.75)?.toFixed(1)}s`);
  }
  if (detLats.length) {
    console.log(`\nDetection latency from mint create (fire_ts − create_ts, n=${detLats.length}):`);
    console.log(`  median: ${pct(detLats, 0.5)?.toFixed(1)}s   p25: ${pct(detLats, 0.25)?.toFixed(1)}s   p75: ${pct(detLats, 0.75)?.toFixed(1)}s   p95: ${pct(detLats, 0.95)?.toFixed(1)}s`);
  }
  if (vsEntries.length) {
    console.log(`\nLatency vs elite entry (fire_ts − elite_entry_ts; positive = we're behind, n=${vsEntries.length}):`);
    console.log(`  median: ${pct(vsEntries, 0.5)?.toFixed(1)}s   p25: ${pct(vsEntries, 0.25)?.toFixed(1)}s   p75: ${pct(vsEntries, 0.75)?.toFixed(1)}s   p95: ${pct(vsEntries, 0.95)?.toFixed(1)}s`);
    const ahead = vsEntries.filter((v) => v < 0).length;
    const behindFar = vsEntries.filter((v) => v > 22).length;
    console.log(`  cases we'd fire BEFORE the elite entry: ${ahead} (${((100 * ahead) / vsEntries.length).toFixed(1)}%)`);
    console.log(`  cases we'd fire >22s AFTER the elite entry: ${behindFar} (${((100 * behindFar) / vsEntries.length).toFixed(1)}%) — past elite median hold`);
  }

  // THE HEADLINE STAT
  console.log(`\n--- THE DECISIVE STAT ---`);
  if (withExit.length === 0) {
    console.log("No elite entries with a known exit timestamp — cannot compute 'fired after exit' fraction.");
  } else {
    const afterPct = (100 * firedAfterExit.length) / withExit.length;
    console.log(`Cases where we'd fire AFTER the elite's exit: ${firedAfterExit.length} of ${withExit.length} (${afterPct.toFixed(1)}%)`);
    console.log(`\n${afterPct > 50 ? "❌" : "✅"} Decision (per plan's pre-registered rule: > 50% AFTER exit ⇒ thesis needs rework):`);
    if (afterPct > 50) {
      console.log("   FAIL — genesis pivot does NOT escape the exit-liquidity-provider role.");
      console.log("   Recommendation: cancel T3.3 (genesis-tuned exits); treat genesis as a dead entry path in T4 (V1).");
      console.log("   Investigate either: (a) shaving 30s window down, (b) a different sub-pattern with longer elite holds,");
      console.log("   or (c) accept slower-tier-participant status and pursue edge via selection-among-elite-buys, not racing.");
    } else {
      console.log("   PASS — in the majority of cases we'd fire while the elite is still holding.");
      console.log("   Recommendation: proceed to T3.1 (OOS validation) and then T3.3 (genesis-tuned exits).");
    }
  }

  // Sample inspection — top 10 cases by 'how far behind elite'
  if (fired.length > 0) {
    console.log(`\nTop 10 worst-case 'we fired far behind elite' (fire_ts − elite_entry_ts):`);
    const sorted = [...fired]
      .filter((x) => x.result.vsEliteEntrySec != null)
      .sort((a, b) => b.result.vsEliteEntrySec! - a.result.vsEliteEntrySec!)
      .slice(0, 10);
    for (const x of sorted) {
      const eliteHold = x.entry.eliteHoldSec != null ? `${x.entry.eliteHoldSec.toFixed(0)}s` : "?";
      const afterExit = x.result.firedAfterEliteExit === true ? " ⚠ AFTER ELITE EXIT" : "";
      console.log(`  ${x.entry.wallet.slice(0, 10)} → ${x.entry.mint.slice(0, 10)}  ` +
        `eliteEntry@${x.entry.eliteEntryVSol?.toFixed(1)}vSol hold=${eliteHold}, ` +
        `we'd fire +${x.result.vsEliteEntrySec?.toFixed(0)}s after them @${x.result.fireVSol?.toFixed(1)}vSol${afterExit}`);
    }
  }

  console.log("\n[T3.2] Analysis complete.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
