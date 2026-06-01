import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { isProfitSignalMode } from "@/lib/env";
import { fetchPumpFunCoins } from "@/lib/pump/fun-api";
import { buildMarketFeed } from "@/lib/market/discovery";
import { upsertTrendCandidates } from "@/lib/db/repos/trend-candidates";
import { insertSnapshotEvents } from "@/lib/db/repos/events";
import { getDb } from "@/lib/db/client";

const log = logger("trend-scanner");
const TICK_MS = 30_000;
/** Background worker — allow slow pump.fun responses under dev compile load. */
const PUMP_FETCH_TIMEOUT_MS = 14_000;

export async function startTrendScanner() {
  if (!isProfitSignalMode()) {
    log.info("trend-scanner disabled (SIGNAL_MODE=launch)");
    return () => undefined;
  }

  log.info("trend-scanner starting", { tickMs: TICK_MS });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const [apiCoins, feed] = await Promise.all([
        fetchPumpFunCoins({
          limit: 60,
          sort: "last_trade_timestamp",
          order: "DESC",
          timeoutMs: PUMP_FETCH_TIMEOUT_MS,
        }),
        buildMarketFeed().catch(() => null),
      ]);

      const byMint = new Map<
        string,
        { mint: string; vSol: number | null; lastTradeAt: string | null; source: string }
      >();

      for (const c of apiCoins) {
        byMint.set(c.mint, {
          mint: c.mint,
          vSol: c.vSol,
          lastTradeAt: c.lastTradeAt,
          source: "pump",
        });
      }

      if (feed) {
        for (const col of [feed.trending, feed.new, feed.migrated]) {
          for (const c of col) {
            if (byMint.has(c.mint)) continue;
            byMint.set(c.mint, {
              mint: c.mint,
              vSol: c.vSol,
              lastTradeAt: c.lastTradeAt,
              source: c.source ?? "market",
            });
          }
        }
      }

      const rows = [...byMint.values()].slice(0, 120);
      if (rows.length === 0) return;

      await upsertTrendCandidates(rows);

      const mints = rows.map((r) => r.mint);
      const recentRes = await getDb().execute(sql`
        SELECT DISTINCT mint::text AS mint
        FROM events
        WHERE mint::text IN (${sql.join(
          mints.map((m) => sql`${m}`),
          sql`, `,
        )})
          AND ts > now() - interval '15 minutes'
          AND kind IN ('buy', 'sell')
      `);
      const recentSet = new Set(
        (recentRes as unknown as { rows: Array<{ mint: string }> }).rows.map((r) => r.mint),
      );

      const snapshots = rows
        .filter((r) => r.vSol != null && r.vSol > 0 && !recentSet.has(r.mint))
        .map((r) => ({ mint: r.mint, vSol: r.vSol! }));

      if (snapshots.length) {
        await insertSnapshotEvents(snapshots);
      }

      log.debug("trend scan", { candidates: rows.length, snapshots: snapshots.length });
    } catch (e) {
      const err = String(e);
      if (err.includes("AbortError")) {
        log.debug("trend-scanner tick aborted (timeout)", { err });
      } else {
        log.warn("trend-scanner tick failed", { err });
      }
    } finally {
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return async () => clearInterval(id);
}
