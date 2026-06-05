import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/log";
import { upsertMintFlags, upsertWalletProfile } from "@/lib/db/repos/bots";

const log = logger("bot-detector");
const MINT_TICK_MS = 30_000;
const WALLET_TICK_MS = 60_000;
const SNIPER_BLOCK_WINDOW = 5; // K=5 from Alg. 2 (≈2s on Solana)
const BUMP_FLIP_THRESHOLD = 50; // ξ=50 from Alg. 3
const BUMP_EPSILON = 1; // ε=1 from Alg. 3

type CreateRow = {
  mint: string;
  creator: string | null;
  launch_slot: string;
  launch_ts: string;
};

/**
 * Implements §4.3 of Luo et al. (WWW '26):
 *   Alg. 1 — Bundle bot:  non-creator BUY in launch slot
 *   Alg. 2 — Sniper bot:  non-creator BUY within K=5 slots after launch
 *   Alg. 3 — Bump bot:    α = F/(|ΔP|+ε) ≥ ξ  (per wallet, per mint)
 *
 * mechanicalUptrend is a candlestick-pattern heuristic for the gradual-bundle
 * dump signature described in §4.3.5 — we approximate it by looking at the
 * smoothness of v_sol growth (low std relative to mean of slope ≈ mechanical).
 */
async function detectMintFlagsBatch() {
  // Pick recently-created mints we haven't classified yet (or whose flags are
  // older than 10 min) and have at least some trade history.
  const newMints = await getDb().execute(sql`
    SELECT c.mint, c.wallet AS creator, c.slot::text AS launch_slot,
      to_char(c.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS launch_ts
    FROM events c
    WHERE c.kind = 'create'
      AND c.mint IS NOT NULL
      AND c.ts >= now() - interval '6 hours'
      AND NOT EXISTS (
        SELECT 1 FROM mint_bot_flags f
        WHERE f.mint = c.mint
          AND (
            -- Recently classified with positive signals: keep cache for 10 min
            (f.early_unique_buyers > 0 AND f.detected_at >= now() - interval '10 minutes')
            -- Or recently classified empty (no early activity yet): retry after 60s
            OR (f.early_unique_buyers = 0 AND f.detected_at >= now() - interval '60 seconds')
          )
      )
    ORDER BY c.ts DESC
    LIMIT 60
  `);
  const rows = (newMints as unknown as { rows: CreateRow[] }).rows;
  if (rows.length === 0) return 0;

  let processed = 0;
  for (const r of rows) {
    try {
      const launchSlot = BigInt(r.launch_slot);
      const launchTs = new Date(r.launch_ts);
      // Pull all trade events for the mint within first 5 minutes — enough to
      // cover all three detectors. Our ingestor stores buys/sells as
      // kind='buy'/'sell' (see lib/pump/parser.ts), so we filter on those.
      const tx = await getDb().execute(sql`
        SELECT slot::text AS slot, wallet, kind, sol_amount, token_amount, v_sol_after,
          to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts
        FROM events
        WHERE mint = ${r.mint}
          AND kind IN ('buy', 'sell')
          AND ts BETWEEN ${launchTs.toISOString()}::timestamptz
                     AND (${launchTs.toISOString()}::timestamptz + interval '5 minutes')
        ORDER BY slot ASC, id ASC
        LIMIT 2000
      `);
      type Tx = {
        slot: string; wallet: string | null; kind: "buy" | "sell";
        sol_amount: number | null; token_amount: number | null;
        v_sol_after: number | null; ts: string;
      };
      const trades = (tx as unknown as { rows: Tx[] }).rows;
      const creator = r.creator;

      // ---- Alg. 1: bundle bot ---------------------------------------------
      const bundleWallets = new Set<string>();
      for (const t of trades) {
        if (t.kind !== "buy") continue;
        if (t.wallet && t.wallet !== creator && BigInt(t.slot) === launchSlot) {
          bundleWallets.add(t.wallet);
        }
      }
      const hasBundle = bundleWallets.size > 0;

      // ---- Alg. 2: sniper bot ---------------------------------------------
      const sniperWallets = new Set<string>();
      for (const t of trades) {
        if (t.kind !== "buy") continue;
        if (!t.wallet || t.wallet === creator) continue;
        const slotDelta = BigInt(t.slot) - launchSlot;
        if (slotDelta > 0n && slotDelta <= BigInt(SNIPER_BLOCK_WINDOW)) {
          sniperWallets.add(t.wallet);
        }
      }
      const hasSniper = sniperWallets.size > 0;

      // ---- Alg. 3: bump bot (per-wallet flip score on this mint) ----------
      const perWallet = new Map<string, Tx[]>();
      for (const t of trades) {
        if (!t.wallet) continue;
        const arr = perWallet.get(t.wallet) ?? [];
        arr.push(t);
        perWallet.set(t.wallet, arr);
      }
      const bumpWallets = new Set<string>();
      for (const [w, list] of perWallet) {
        list.sort((a, b) => Number(BigInt(a.slot) - BigInt(b.slot)));
        let flips = 0;
        let netTokens = 0;
        for (let i = 0; i < list.length; i++) {
          const cur = list[i]!;
          const sign = cur.kind === "buy" ? 1 : -1;
          const tok = (cur.token_amount ?? 0) * sign;
          netTokens += tok;
          const next = list[i + 1];
          if (
            next &&
            cur.kind !== next.kind &&
            Math.abs((cur.token_amount ?? 0) - (next.token_amount ?? 0)) <
              0.01 * Math.max(1e-6, cur.token_amount ?? 0)
          ) {
            flips++;
          }
        }
        const alpha = flips / (Math.abs(netTokens) + BUMP_EPSILON);
        if (alpha >= BUMP_FLIP_THRESHOLD && flips >= 4) {
          bumpWallets.add(w);
        }
      }
      const hasBumpBot = bumpWallets.size > 0;

      // ---- mechanical uptrend (proxy for §4.3.5 gradual bundle) -----------
      const vSeries = trades
        .filter((t) => t.v_sol_after != null)
        .map((t) => t.v_sol_after as number);
      let mechanicalUptrend = false;
      if (vSeries.length >= 8) {
        const slopes: number[] = [];
        for (let i = 1; i < vSeries.length; i++) {
          slopes.push(vSeries[i]! - vSeries[i - 1]!);
        }
        const positive = slopes.filter((s) => s > 0);
        const mean =
          positive.length > 0 ? positive.reduce((a, b) => a + b, 0) / positive.length : 0;
        const std =
          positive.length > 1
            ? Math.sqrt(
                positive.reduce((a, b) => a + (b - mean) ** 2, 0) / (positive.length - 1),
              )
            : 0;
        const cv = mean > 0 ? std / mean : Infinity;
        // Mechanical uptrend = many small near-equal positive slopes, low coefficient of variation.
        // Combined with elevated bundle/sniper presence the decision worker treats it as a strong veto.
        mechanicalUptrend = positive.length >= 8 && cv < 0.45;
      }

      const earlyUniqueBuyers = new Set(
        trades
          .filter((t) => t.kind === "buy" && t.wallet && t.wallet !== creator)
          .map((t) => t.wallet as string),
      ).size;

      await upsertMintFlags({
        mint: r.mint,
        creator,
        launchSlot,
        launchTs,
        hasBundle,
        hasSniper,
        hasBumpBot,
        mechanicalUptrend,
        bundleWalletCount: bundleWallets.size,
        sniperWalletCount: sniperWallets.size,
        bumpWalletCount: bumpWallets.size,
        earlyUniqueBuyers,
      });
      processed++;
    } catch (e) {
      log.warn("mint detect failed", { mint: r.mint, err: String(e) });
    }
  }
  return processed;
}

/**
 * Build/refresh wallet_profiles. For each (wallet, mint) pair, we approximate
 * realized return as (sumSolSells - sumSolBuys)/sumSolBuys when the wallet has
 * effectively closed the position (net token balance ≈ 0).
 *
 * This is an approximation of paper's "first-position realized return" using
 * the data we ingest from logsSubscribe.
 */
async function refreshWalletProfilesBatch() {
  // Pick wallets with recent activity in the last hour that we haven't
  // refreshed in the last 10 minutes.
  const candidates = await getDb().execute(sql`
    SELECT e.wallet
    FROM events e
    LEFT JOIN wallet_profiles wp ON wp.wallet = e.wallet
    WHERE e.wallet IS NOT NULL
      AND e.kind IN ('buy','sell')
      AND e.ts >= now() - interval '1 hour'
      AND (wp.last_updated IS NULL OR wp.last_updated < now() - interval '10 minutes')
    GROUP BY e.wallet
    ORDER BY MAX(e.ts) DESC
    LIMIT 80
  `);
  type W = { wallet: string };
  const wallets = (candidates as unknown as { rows: W[] }).rows.map((r) => r.wallet);
  if (wallets.length === 0) return 0;

  // Aggregate per (wallet, mint) the buy/sell sums.
  const wlist = wallets.map((w) => `'${w.replace(/'/g, "''")}'`).join(",");
  const agg = await getDb().execute(sql`
    SELECT wallet, mint,
      COALESCE(SUM(CASE WHEN kind='buy'  THEN sol_amount END),0)::float8 AS sol_in,
      COALESCE(SUM(CASE WHEN kind='sell' THEN sol_amount END),0)::float8 AS sol_out,
      COALESCE(SUM(CASE WHEN kind='buy'  THEN token_amount END),0)::float8 AS tok_in,
      COALESCE(SUM(CASE WHEN kind='sell' THEN token_amount END),0)::float8 AS tok_out,
      COUNT(*)::int AS n,
      MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM events
    WHERE wallet IN (${sql.raw(wlist)}) AND kind IN ('buy','sell') AND mint IS NOT NULL
    GROUP BY wallet, mint
  `);
  type A = {
    wallet: string; mint: string;
    sol_in: number; sol_out: number;
    tok_in: number; tok_out: number;
    n: number; first_ts: Date; last_ts: Date;
  };
  const aggRows = (agg as unknown as { rows: A[] }).rows;

  const byWallet = new Map<string, A[]>();
  for (const r of aggRows) {
    const arr = byWallet.get(r.wallet) ?? [];
    arr.push(r);
    byWallet.set(r.wallet, arr);
  }

  // Sniper/bundle frequency for each wallet — fraction of (wallet, mint) pairs
  // where the wallet's first buy occurred within K=5 slots of mint launch.
  const sniperBundle = await getDb().execute(sql`
    WITH first_buy AS (
      SELECT e.wallet, e.mint,
        MIN(e.slot) FILTER (WHERE e.kind='buy') AS first_buy_slot
      FROM events e
      WHERE e.wallet IN (${sql.raw(wlist)})
      GROUP BY e.wallet, e.mint
    ),
    launches AS (
      SELECT mint, MIN(slot) AS launch_slot, MIN(wallet) AS creator
      FROM events
      WHERE kind='create'
      GROUP BY mint
    )
    SELECT fb.wallet,
      COUNT(*) FILTER (WHERE fb.first_buy_slot = l.launch_slot AND fb.wallet <> l.creator)::int AS bundle_n,
      COUNT(*) FILTER (
        WHERE fb.first_buy_slot > l.launch_slot
          AND fb.first_buy_slot <= l.launch_slot + ${SNIPER_BLOCK_WINDOW}
          AND fb.wallet <> l.creator
      )::int AS sniper_n,
      COUNT(*)::int AS total_n
    FROM first_buy fb
    JOIN launches l ON l.mint = fb.mint
    GROUP BY fb.wallet
  `);
  type SB = { wallet: string; bundle_n: number; sniper_n: number; total_n: number };
  const sbMap = new Map<string, SB>();
  for (const r of (sniperBundle as unknown as { rows: SB[] }).rows) {
    sbMap.set(r.wallet, r);
  }

  let updated = 0;
  for (const [wallet, perMint] of byWallet) {
    perMint.sort((a, b) => new Date(a.first_ts).getTime() - new Date(b.first_ts).getTime());
    const closedReturns: number[] = [];
    let totalTrades = 0;
    let firstSeen: Date | null = null;
    let lastSeen: Date | null = null;
    let fullyClosed = 0;
    for (const m of perMint) {
      totalTrades += m.n;
      const f = new Date(m.first_ts);
      const l = new Date(m.last_ts);
      if (!firstSeen || f < firstSeen) firstSeen = f;
      if (!lastSeen || l > lastSeen) lastSeen = l;
      if (m.sol_in <= 1e-6) continue; // no real buy leg to measure
      const remainingTokens = m.tok_in - m.tok_out;
      if (remainingTokens <= 0.05 * Math.max(1e-6, m.tok_in)) fullyClosed++;
      // GMGN-style realized return: SOL out vs SOL in across the WHOLE position.
      // Tokens the wallet never sold are valued at ~0 — on pump.fun an un-exited
      // bag is almost always a loss. Scoring EVERY position (not just the ones the
      // wallet fully sold) removes the survivorship bias where only sold winners
      // counted and dead bags were invisible (which inflated losers into "smart").
      const ret = (m.sol_out - m.sol_in) / m.sol_in;
      if (Number.isFinite(ret) && ret >= -1 && ret < 50) {
        closedReturns.push(ret);
      }
    }

    const n = closedReturns.length;
    const avg = n ? closedReturns.reduce((a, b) => a + b, 0) / n : null;
    const std =
      n > 1
        ? Math.sqrt(
            closedReturns.reduce((a, b) => a + (b - (avg ?? 0)) ** 2, 0) / (n - 1),
          )
        : null;
    const tStat = avg != null && std != null && std > 0 ? avg / (std / Math.sqrt(n)) : null;
    const lastReturn = closedReturns.at(-1) ?? null;
    const last5 =
      closedReturns.length >= 1
        ? closedReturns.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, closedReturns.length)
        : null;
    const last10 =
      closedReturns.length >= 1
        ? closedReturns.slice(-10).reduce((a, b) => a + b, 0) /
          Math.min(10, closedReturns.length)
        : null;

    const sb = sbMap.get(wallet);
    const sniperRate = sb && sb.total_n > 0 ? sb.sniper_n / sb.total_n : null;
    const bundleRate = sb && sb.total_n > 0 ? sb.bundle_n / sb.total_n : null;

    // bump bot heuristic on a per-wallet basis: high sniper rate AND tight,
    // low absolute returns. Real per-flip detection lives in the per-mint
    // detector; here we just propagate up the cross-coin signal.
    const isBumpBot =
      perMint.length >= 5 &&
      avg != null &&
      Math.abs(avg) < 0.02 &&
      (sniperRate ?? 0) > 0.6;

    await upsertWalletProfile({
      wallet,
      tradeCount: totalTrades,
      distinctMints: perMint.length,
      // closedMints = positions the wallet actually fully exited (real sell history),
      // used by the smart-money filter so pure bag-holders don't qualify. avg/std/
      // t_stat below are computed over ALL scored positions (incl. unsold bags @ ~0).
      closedMints: fullyClosed,
      avgReturn: avg,
      stdReturn: std,
      tStat,
      lastReturn,
      last5Return: last5,
      last10Return: last10,
      firstSeen,
      lastSeen,
      isBumpBot,
      bumpScore: isBumpBot ? 1 : 0,
      sniperRate,
      bundleRate,
      recentReturns: closedReturns.slice(-15),
    });
    updated++;
  }
  return updated;
}

export async function startBotDetector() {
  log.info("bot-detector starting", {
    mintTickMs: MINT_TICK_MS,
    walletTickMs: WALLET_TICK_MS,
  });

  let running = false;
  let walletRunning = false;

  async function mintTick() {
    if (running) return;
    running = true;
    try {
      const n = await detectMintFlagsBatch();
      if (n > 0) log.info("mint flags refreshed", { n });
    } catch (e) {
      log.error("mint tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  }

  async function walletTick() {
    if (walletRunning) return;
    walletRunning = true;
    try {
      const n = await refreshWalletProfilesBatch();
      if (n > 0) log.info("wallet profiles refreshed", { n });
    } catch (e) {
      log.error("wallet tick failed", { err: String(e) });
    } finally {
      walletRunning = false;
    }
  }

  const m = setInterval(() => {
    mintTick().catch((e) => log.error("mint reject", { err: String(e) }));
  }, MINT_TICK_MS);
  const w = setInterval(() => {
    walletTick().catch((e) => log.error("wallet reject", { err: String(e) }));
  }, WALLET_TICK_MS);
  setTimeout(() => mintTick().catch(() => undefined), 8_000);
  setTimeout(() => walletTick().catch(() => undefined), 15_000);
  return () => {
    clearInterval(m);
    clearInterval(w);
  };
}
