import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import { fetchPumpFunCoin } from "@/lib/pump/fun-api";
import { touchWorker } from "@/lib/workers/heartbeat";

/**
 * Post-exit forward-return poller.
 *
 * Problem this solves: our `events` table only captures bonding-curve trades.
 * Most coins we auto-trade graduate to PumpSwap shortly after our exit, so the
 * label-builder (which reads `events`) has no forward data for them. Result:
 * we can't see whether a coin pumped after we sold (the user's observation that
 * many do). `mint_dex_quotes` is also empty for unwatched mints.
 *
 * Fix: at each close, the auto-trader writes a `feature_snapshots` row with
 * `sample_source='post_exit'` and `ref_mcap_usd=exit mcap`. This worker polls
 * the pump.fun API (which knows graduated mcaps too) at 5min/30min/1h/6h after
 * exit and writes the return into the existing `outcome_labels` table.
 *
 * Per-tick budget: one API call per snapshot per tick (a single snapshot fills
 * at most one horizon column per tick). pump.fun has an 8s TTL cache so 5-10
 * polls/min stays well under any rate limit.
 *
 * T1.2 update: once PumpSwap ingestion is on, graduated coins' post-exit prices
 * are available ON-CHAIN in `events` (venue='pumpswap', continuous effective
 * vSol). Preferring those over the API scrape (API as fallback only) removes a
 * rate-limited dependency from the measurement loop — folded into the T1.2g
 * follow-up so it ships with the PumpSwap gap-recovery that guarantees those
 * on-chain rows are complete. Until then the API path remains authoritative.
 */
const log = logger("post-exit-poller");
const TICK_MS = 60_000;
const SIX_HOURS_SEC = 6 * 3_600;
const BATCH = 30;

type DueRow = {
  id: string;
  mint: string;
  ts: Date;
  refMcap: number | null;
  ageSec: number;
  ret5m: number | null;
  ret30m: number | null;
  ret1h: number | null;
  ret6h: number | null;
};

async function fetchDuePostExits(limit = BATCH): Promise<DueRow[]> {
  const res = await getDb().execute(sql`
    SELECT fs.id::text AS id, fs.mint::text AS mint, fs.ts,
      fs.ref_mcap_usd::float8 AS ref_mcap,
      EXTRACT(EPOCH FROM (now() - fs.ts))::float8 AS age_sec,
      ol.ret_5m::float8 AS ret_5m,
      ol.ret_30m::float8 AS ret_30m,
      ol.ret_1h::float8 AS ret_1h,
      ol.ret_6h::float8 AS ret_6h
    FROM feature_snapshots fs
    LEFT JOIN outcome_labels ol ON ol.snapshot_id = fs.id
    WHERE fs.sample_source = 'post_exit'
      AND fs.ts < now() - interval '4 minutes'
      AND fs.ts > now() - interval '24 hours'
      AND (ol.id IS NULL OR ol.horizons_complete = false)
    ORDER BY fs.ts ASC
    LIMIT ${limit}
  `);
  return (
    res as unknown as {
      rows: Array<{
        id: string;
        mint: string;
        ts: Date | string;
        ref_mcap: number | null;
        age_sec: number;
        ret_5m: number | null;
        ret_30m: number | null;
        ret_1h: number | null;
        ret_6h: number | null;
      }>;
    }
  ).rows.map((r) => ({
    id: r.id,
    mint: r.mint,
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts),
    refMcap: r.ref_mcap,
    ageSec: r.age_sec,
    ret5m: r.ret_5m,
    ret30m: r.ret_30m,
    ret1h: r.ret_1h,
    ret6h: r.ret_6h,
  }));
}

/** Patch a single horizon column without disturbing the others. */
async function patchRet(
  snapshotId: string,
  mint: string,
  baseTs: Date,
  column: "ret_5m" | "ret_30m" | "ret_1h" | "ret_6h",
  value: number,
): Promise<void> {
  // Insert if no row yet; otherwise update only the target column (and keep
  // existing values for the others via COALESCE).
  await getDb().execute(sql`
    INSERT INTO outcome_labels
      (snapshot_id, mint, base_ts, ${sql.raw(column)}, horizons_complete, label_ready_at)
    VALUES
      (${BigInt(snapshotId)}, ${mint}, ${baseTs.toISOString()}, ${value}, false, now())
    ON CONFLICT (snapshot_id) DO UPDATE SET
      ${sql.raw(column)} = COALESCE(outcome_labels.${sql.raw(column)}, EXCLUDED.${sql.raw(column)}),
      label_ready_at = now()
  `);
}

/** After 6h, compute max/min from the four horizon values and mark complete. */
async function finalize(snapshotId: string, mint: string, baseTs: Date): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO outcome_labels
      (snapshot_id, mint, base_ts, horizons_complete, label_ready_at,
       max_gain_pct, max_drawdown_pct, is_rug, is_breakout)
    VALUES
      (${BigInt(snapshotId)}, ${mint}, ${baseTs.toISOString()}, true, now(),
       NULL, NULL, NULL, NULL)
    ON CONFLICT (snapshot_id) DO UPDATE SET
      horizons_complete = true,
      max_gain_pct = GREATEST(
        COALESCE(outcome_labels.ret_5m, -1),
        COALESCE(outcome_labels.ret_30m, -1),
        COALESCE(outcome_labels.ret_1h, -1),
        COALESCE(outcome_labels.ret_6h, -1)
      ),
      max_drawdown_pct = LEAST(
        COALESCE(outcome_labels.ret_5m, 1),
        COALESCE(outcome_labels.ret_30m, 1),
        COALESCE(outcome_labels.ret_1h, 1),
        COALESCE(outcome_labels.ret_6h, 1)
      ),
      is_rug = (LEAST(
        COALESCE(outcome_labels.ret_5m, 1),
        COALESCE(outcome_labels.ret_30m, 1),
        COALESCE(outcome_labels.ret_1h, 1),
        COALESCE(outcome_labels.ret_6h, 1)
      ) <= -0.85),
      is_breakout = (GREATEST(
        COALESCE(outcome_labels.ret_5m, -1),
        COALESCE(outcome_labels.ret_30m, -1),
        COALESCE(outcome_labels.ret_1h, -1),
        COALESCE(outcome_labels.ret_6h, -1)
      ) >= 1.0),
      label_ready_at = now()
  `);
}

async function pollOne(row: DueRow): Promise<boolean> {
  // Which horizon needs filling? Take the youngest matured-but-empty one — that
  // way the API mcap (which is "now") is closest to the horizon timestamp.
  type Slot = { col: "ret_5m" | "ret_30m" | "ret_1h" | "ret_6h"; secs: number; cur: number | null };
  const slots: Slot[] = [
    { col: "ret_5m", secs: 5 * 60, cur: row.ret5m },
    { col: "ret_30m", secs: 30 * 60, cur: row.ret30m },
    { col: "ret_1h", secs: 60 * 60, cur: row.ret1h },
    { col: "ret_6h", secs: SIX_HOURS_SEC, cur: row.ret6h },
  ];
  const dueSlot = slots.find((s) => s.cur == null && row.ageSec >= s.secs);

  if (dueSlot && row.refMcap != null && row.refMcap > 0) {
    const coin = await fetchPumpFunCoin(row.mint).catch(() => null);
    if (coin?.usdMarketCap != null && coin.usdMarketCap > 0) {
      const ret = coin.usdMarketCap / row.refMcap - 1;
      if (Number.isFinite(ret)) {
        await patchRet(row.id, row.mint, row.ts, dueSlot.col, ret);
      }
    }
  }

  // Finalize once fully matured — even if some horizons came back null (rate
  // limits, dead coins). Otherwise the row stays pending forever.
  if (row.ageSec >= SIX_HOURS_SEC) {
    await finalize(row.id, row.mint, row.ts);
    return true;
  }
  return dueSlot != null;
}

export function startPostExitPoller(): () => void {
  log.info("post-exit-poller starting", { tickMs: TICK_MS });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    touchWorker("post-exit-poller");
    try {
      const due = await fetchDuePostExits(BATCH);
      let polled = 0;
      for (const row of due) {
        try {
          if (await pollOne(row)) polled++;
        } catch (e) {
          log.warn("poll one failed", { id: row.id, err: String(e) });
        }
      }
      if (polled > 0) log.debug("post-exit polled", { polled, scanned: due.length });
    } catch (e) {
      log.warn("post-exit-poller tick failed", { err: String(e) });
    } finally {
      touchWorker("post-exit-poller", { tickMs: Date.now() - t0 });
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(id);
}
