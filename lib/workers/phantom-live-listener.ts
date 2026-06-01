import "server-only";
/**
 * Transitional poll listener (localhost single-worker). Future: LISTEN/NOTIFY.
 *
 * PHANTOM LIVE EXCEPTION (browser-signed):
 * Phantom signs in the browser; the worker cannot own that session.
 * This listener is the ONLY audited path where a web-queued command results in
 * live ledger writes after client broadcast. Do not copy for generic execution.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { appendEvent } from "@spr/core";
import { logger } from "@/lib/log";
import { recordPhantomLiveBuy, recordPhantomLiveSell } from "@/lib/executor/live";
import type { LiveTradeRoute } from "@/lib/db/repos/live-trades";

const log = logger("phantom-live-listener");

const POLL_MS = 1_500;
const BATCH = 5;

export function startPhantomLiveListener(): () => void {
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const res = await getDb().execute(sql`
        SELECT de.id::text AS id, de.payload, de.correlation_id
        FROM domain_events de
        WHERE de.type = 'PHANTOM_LIVE_RECORD_REQUESTED'
          AND de.occurred_at > now() - interval '5 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM domain_events done
            WHERE done.type IN ('PHANTOM_LIVE_RECORDED', 'PHANTOM_LIVE_REJECTED')
              AND done.correlation_id = de.correlation_id
          )
        ORDER BY de.id ASC
        LIMIT ${sql.raw(String(BATCH))}
      `);
      type Row = {
        id: string;
        payload: Record<string, unknown>;
        correlation_id: string | null;
      };
      for (const r of (res as unknown as { rows: Row[] }).rows) {
        if (stopped) break;
        await processRecord(r);
      }
    } catch (e) {
      log.warn("tick failed", { err: String(e) });
    } finally {
      busy = false;
    }
  };

  const t = setInterval(() => void tick(), POLL_MS);
  setTimeout(() => void tick(), 2_000);
  return () => {
    stopped = true;
    clearInterval(t);
  };
}

async function processRecord(r: {
  payload: Record<string, unknown>;
  correlation_id: string | null;
}) {
  const correlationId = r.correlation_id;
  if (!correlationId) return;
  const p = r.payload;
  const side = p.side === "buy" || p.side === "sell" ? p.side : null;
  const mint = typeof p.mint === "string" ? p.mint : "";
  const signature = typeof p.signature === "string" ? p.signature : "";
  const route = p.route as LiveTradeRoute;
  if (!side || !mint || !signature) {
    await reject(correlationId, "invalid_payload");
    return;
  }
  try {
    if (side === "buy") {
      const sizeSol = Number(p.sizeSol);
      if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
        await reject(correlationId, "invalid_size");
        return;
      }
      const res = await recordPhantomLiveBuy({
        mint,
        sizeSol,
        signature,
        route,
        entryVSol: typeof p.entryVSol === "number" ? p.entryVSol : null,
        publicKey: typeof p.publicKey === "string" ? p.publicKey : "",
      });
      if (!res.ok) {
        await reject(correlationId, res.error ?? "record_failed");
        return;
      }
      await appendEvent({
        type: "PHANTOM_LIVE_RECORDED",
        payload: { ok: true, tradeId: res.tradeId.toString(), side: "buy" },
        correlationId,
      }).catch(() => undefined);
    } else {
      const percent = Number(p.percent ?? 100);
      const res = await recordPhantomLiveSell({ mint, percent, signature, route });
      if (!res.ok) {
        await reject(correlationId, res.error ?? "record_failed");
        return;
      }
      await appendEvent({
        type: "PHANTOM_LIVE_RECORDED",
        payload: { ok: true, tradeId: res.tradeId?.toString() ?? null, side: "sell" },
        correlationId,
      }).catch(() => undefined);
    }
  } catch (e) {
    await reject(correlationId, String(e).slice(0, 200));
  }
}

async function reject(correlationId: string, reason: string) {
  await appendEvent({
    type: "PHANTOM_LIVE_REJECTED",
    payload: { reason },
    correlationId,
  }).catch(() => undefined);
}
