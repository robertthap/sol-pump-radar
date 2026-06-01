import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { appendEvent } from "@spr/core";
import { env, rpcHttpUrls } from "@/lib/env";
import { logger } from "@/lib/log";
import { peekKeypair } from "@/lib/wallet/session";
import { executeLiveBuy, executeLiveSell } from "@/lib/executor/live";
import { fetchOpenLiveByMint, markLivePositionCloseFailed } from "@/lib/db/repos/live-trades";

const log = logger("live-exec-listener");

const POLL_MS = 1_000;
const BATCH = 5;
const MAX_LISTENER_FAILURES = 3;
const COOLDOWN_MS = 60_000;

type IntentRow = {
  id: string;
  payload: {
    side?: "buy" | "sell";
    mint?: string;
    sizeSol?: number;
    percent?: number;
    entryVSol?: number | null;
    source?: string;
    strategy_id?: string;
    liveTradeId?: string;
  };
  correlation_id: string | null;
};

/**
 * Transitional poll listener (localhost single-worker). Risks: duplicate scans,
 * burst inefficiency, listener overlap. Future: LISTEN/NOTIFY or leased job table.
 *
 * Worker-only: processes LIVE_TRADE_INTENT from the web-write gate.
 */
export function startLiveExecutionListener(): () => void {
  let stopped = false;
  let busy = false;
  let consecutiveFailures = 0;
  let cooldownUntil = 0;

  const enterCooldown = async (reason: string) => {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    await appendEvent({
      type: "LIVE_EXECUTION_COOLDOWN",
      payload: {
        reason,
        failures: consecutiveFailures,
        cooldownMs: COOLDOWN_MS,
        until: new Date(cooldownUntil).toISOString(),
      },
      dedupeKey: `live:cooldown:${Math.floor(cooldownUntil / 1000)}`,
    }).catch(() => undefined);
    log.warn("live execution cooldown", { reason, until: cooldownUntil });
    consecutiveFailures = 0;
  };

  const noteFailure = async (reason: string) => {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_LISTENER_FAILURES) {
      await enterCooldown(reason);
    }
  };

  const markRejected = async (
    correlationId: string,
    reason: string,
    extra: Record<string, unknown>,
  ) => {
    await appendEvent({
      type: "LIVE_TRADE_REJECTED",
      payload: { reason, ...extra },
      correlationId,
    }).catch(() => undefined);
    await appendEvent({
      type: "LIVE_TRADE_COMPLETED",
      payload: { ok: false, reason, ...extra },
      correlationId,
    }).catch(() => undefined);
    await noteFailure(reason);
  };

  const processIntent = async (r: IntentRow) => {
    const correlationId = r.correlation_id;
    if (!correlationId) {
      log.warn("intent missing correlation_id; skipping", { id: r.id });
      return;
    }
    const p = r.payload ?? {};
    if (typeof p.strategy_id !== "string" || !p.strategy_id) {
      await markRejected(correlationId, "missing_strategy_id", { id: r.id });
      return;
    }
    const side = p.side === "buy" || p.side === "sell" ? p.side : null;
    const mint = typeof p.mint === "string" ? p.mint : "";
    if (!side || !mint) {
      await markRejected(correlationId, "invalid_payload", { id: r.id, payload: p });
      return;
    }

    const { assertLiveExecutionAllowed } = await import("@/lib/runtime/live-guards");
    const gate = await assertLiveExecutionAllowed();
    if (!gate.ok) {
      await markRejected(correlationId, gate.reason, { mint, side });
      return;
    }

    const kp = peekKeypair();
    if (!kp) {
      await markRejected(correlationId, "wallet_locked", {
        mint,
        side,
        hint: "Set VAULT_PASSPHRASE in .env.local and restart the worker.",
      });
      return;
    }

    const rpcUrl = rpcHttpUrls()[0];
    if (!rpcUrl) {
      await markRejected(correlationId, "no_rpc_url", { mint, side });
      return;
    }

    log.info("executing intent", { id: r.id, correlationId, side, mint });
    try {
      if (side === "buy") {
        const sizeSol = typeof p.sizeSol === "number" ? p.sizeSol : Number(p.sizeSol);
        if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
          await markRejected(correlationId, "invalid_size", { mint });
          return;
        }
        const result = await executeLiveBuy({
          mint,
          sizeSol,
          keypair: kp,
          rpcUrl,
          entryVSol: p.entryVSol ?? null,
        });
        await appendEvent({
          type: "LIVE_TRADE_ATTEMPT",
          payload: {
            route: "worker-listener",
            mint,
            sizeSol,
            ok: result.ok,
            dryRun: result.dryRun,
            executor: result.route,
            tradeId: result.tradeId?.toString() ?? null,
            error: result.error ?? null,
          },
          correlationId,
        }).catch(() => undefined);
        await appendEvent({
          type: "LIVE_TRADE_COMPLETED",
          payload: {
            side,
            mint,
            ok: result.ok,
            dryRun: result.dryRun,
            signature: result.signature ?? result.simulatedSignature ?? null,
            route: result.route,
            tradeId: result.tradeId?.toString() ?? null,
            error: result.error ?? null,
          },
          correlationId,
        }).catch(() => undefined);
        if (result.ok) consecutiveFailures = 0;
        else await noteFailure(result.error ?? "execution_failed");
        return;
      }
      const percent = typeof p.percent === "number" ? p.percent : Number(p.percent);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        await markRejected(correlationId, "invalid_percent", { mint });
        return;
      }
      const result = await executeLiveSell({ mint, percent, keypair: kp, rpcUrl });
      await appendEvent({
        type: "LIVE_TRADE_ATTEMPT",
        payload: {
          route: "worker-listener",
          mint,
          percent,
          ok: result.ok,
          dryRun: result.dryRun,
          executor: result.route,
          tradeId: result.tradeId?.toString() ?? null,
          error: result.error ?? null,
        },
        correlationId,
      }).catch(() => undefined);
      await appendEvent({
        type: "LIVE_TRADE_COMPLETED",
        payload: {
          side,
          mint,
          ok: result.ok,
          dryRun: result.dryRun,
          signature: result.signature ?? result.simulatedSignature ?? null,
          route: result.route,
          tradeId: result.tradeId?.toString() ?? null,
          error: result.error ?? null,
        },
        correlationId,
      }).catch(() => undefined);
      if (result.ok) consecutiveFailures = 0;
      else {
        const open = await fetchOpenLiveByMint(mint);
        const tradeId = open[0]?.id ?? null;
        if (tradeId) {
          await markLivePositionCloseFailed(tradeId, result.error ?? "execution_failed");
          log.warn("live sell failed — position marked close_failed", {
            mint,
            tradeId: tradeId.toString(),
            err: result.error,
            source: p.source,
          });
        }
        await noteFailure(result.error ?? "execution_failed");
      }
    } catch (e) {
      log.error("intent processing threw", { id: r.id, err: String(e) });
      await markRejected(correlationId, "exception", { mint, side, err: String(e) });
    }
  };

  const tick = async () => {
    if (stopped || busy) return;
    if (Date.now() < cooldownUntil) return;
    busy = true;
    try {
      const res = await getDb().execute(sql`
        SELECT de.id::text AS id,
               de.payload,
               de.correlation_id
        FROM domain_events de
        WHERE de.type = 'LIVE_TRADE_INTENT'
          AND de.occurred_at > now() - interval '5 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM domain_events done
            WHERE done.type = 'LIVE_TRADE_COMPLETED'
              AND done.correlation_id = de.correlation_id
          )
        ORDER BY de.id ASC
        LIMIT ${sql.raw(String(BATCH))}
      `);
      const rows = (res as unknown as { rows: IntentRow[] }).rows;
      for (const r of rows) {
        if (stopped) break;
        await processIntent(r);
      }
    } catch (e) {
      log.warn("listener tick failed", { err: String(e) });
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
