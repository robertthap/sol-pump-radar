import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paperReset } from "./engine";
import { logger } from "@/lib/log";

const log = logger("paper-reset");

const POLL_MS = 2_000;
const PROCESSED_KEY_PREFIX = "paper:reset:processed:";

/**
 * The web UI requests a reset by appending a PAPER_RESET_REQUESTED domain
 * event through the executeWebMutation gate. The worker watches for new
 * requests and applies them transactionally via paperReset.
 *
 * Dedup uses domain_events.dedupe_key to prevent re-processing on restart.
 */
export function startPaperResetListener(): () => void {
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const res = await getDb().execute(sql`
        SELECT de.id::text AS id,
               de.payload,
               de.correlation_id,
               de.dedupe_key
        FROM domain_events de
        WHERE de.type = 'PAPER_RESET_REQUESTED'
          AND de.occurred_at > now() - interval '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM domain_events done
            WHERE done.type = 'PAPER_RESET_COMPLETED'
              AND done.correlation_id = de.correlation_id
          )
        ORDER BY de.id ASC
        LIMIT 5
      `);
      type Row = { id: string; payload: { reason?: string; startSol?: number }; correlation_id: string | null };
      const rows = (res as unknown as { rows: Row[] }).rows;
      for (const r of rows) {
        const reason = r.payload?.reason ?? "user reset";
        const correlationId = r.correlation_id ?? `${PROCESSED_KEY_PREFIX}${r.id}`;
        log.info("processing reset request", { id: r.id, reason, correlationId });
        const out = await paperReset({
          reason,
          startSol: r.payload?.startSol,
          correlationId,
        });
        if (!out.ok) {
          log.warn("reset failed", { id: r.id, code: out.code, reason: out.reason });
        } else {
          log.info("reset complete", {
            id: r.id,
            oldSessionId: out.data.oldSessionId.toString(),
            newSessionId: out.data.newSessionId.toString(),
            closedPositions: out.data.closedPositions,
          });
        }
      }
    } catch (e) {
      log.warn("listener tick failed", { err: String(e) });
    } finally {
      busy = false;
    }
  };

  const t = setInterval(() => {
    void tick();
  }, POLL_MS);
  setTimeout(() => void tick(), 1_500);

  return () => {
    stopped = true;
    clearInterval(t);
  };
}
