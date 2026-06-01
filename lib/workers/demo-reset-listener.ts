import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { appendEvent } from "@spr/core";
import { logger } from "@/lib/log";
import { executeDemoWalletReset } from "@/lib/db/repos/trading-mode";

const log = logger("demo-reset-listener");

const POLL_MS = 2_000;
const BATCH = 3;

/**
 * Transitional poll listener (localhost single-worker). Future: LISTEN/NOTIFY.
 * Worker-only — web must not close demo positions directly.
 */
export function startDemoResetListener(): () => void {
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const res = await getDb().execute(sql`
        SELECT de.id::text AS id,
               de.payload,
               de.correlation_id
        FROM domain_events de
        WHERE de.type = 'DEMO_RESET_REQUESTED'
          AND de.occurred_at > now() - interval '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM domain_events done
            WHERE done.type IN ('DEMO_RESET_COMPLETED', 'DEMO_RESET_REJECTED')
              AND done.correlation_id = de.correlation_id
          )
        ORDER BY de.id ASC
        LIMIT ${sql.raw(String(BATCH))}
      `);
      type Row = {
        id: string;
        payload: { strategy_id?: string };
        correlation_id: string | null;
      };
      for (const r of (res as unknown as { rows: Row[] }).rows) {
        if (stopped) break;
        await processReset(r);
      }
    } catch (e) {
      log.warn("tick failed", { err: String(e) });
    } finally {
      busy = false;
    }
  };

  const t = setInterval(() => void tick(), POLL_MS);
  setTimeout(() => void tick(), 1_500);

  return () => {
    stopped = true;
    clearInterval(t);
  };
}

async function processReset(r: { id: string; correlation_id: string | null }) {
  const correlationId = r.correlation_id;
  if (!correlationId) {
    log.warn("demo reset missing correlation_id", { id: r.id });
    return;
  }
  try {
    const demo = await executeDemoWalletReset();
    await appendEvent({
      type: "DEMO_RESET_COMPLETED",
      payload: { ok: true, demo },
      correlationId,
    }).catch(() => undefined);
    log.info("demo wallet reset complete", {
      closedTrades: demo.closedTrades,
      balanceSol: demo.balanceSol,
    });
  } catch (e) {
    const reason = String(e).slice(0, 200);
    await appendEvent({
      type: "DEMO_RESET_REJECTED",
      payload: { reason },
      correlationId,
    }).catch(() => undefined);
    await appendEvent({
      type: "DEMO_RESET_COMPLETED",
      payload: { ok: false, reason },
      correlationId,
    }).catch(() => undefined);
    log.warn("demo reset failed", { reason });
  }
}
