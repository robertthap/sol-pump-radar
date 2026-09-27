import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { appendEvent } from "@spr/core";
import { logger } from "@/lib/log";
import {
  paperOpen,
  paperClose,
  paperResearchCensor,
  paperResearchCloseAtMark,
} from "@/lib/paper/engine";
import { fetchDemoAccount } from "@/lib/db/repos/trading-mode";
import { recordOutcome } from "@/lib/db/repos/outcomes";
import {
  fetchSellableOpenPaperPositions,
  type SellablePaperRow,
} from "@/lib/paper/sellable-positions";
import { isAutoPaperEntry, manualPaperExitReason } from "@/lib/paper/sell-helpers";
import { finishResearchEpisode } from "@/lib/db/repos/research-bot";

const log = logger("paper-trade-listener");

const POLL_MS = 1_000;
const BATCH = 5;

type IntentRow = {
  id: string;
  payload: {
    side?: "buy" | "sell" | "sell_all";
    mint?: string;
    sizeSol?: number;
    entryVSol?: number | null;
    source?: string;
    strategy_id?: string;
    session_id?: string;
    scope?: "all" | "auto";
  };
  correlation_id: string | null;
};

/**
 * Transitional poll listener (localhost single-worker). Future: LISTEN/NOTIFY.
 * Worker-only: processes PAPER_TRADE_INTENT from the web-write gate.
 */
export function startPaperTradeListener(): () => void {
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
        WHERE de.type = 'PAPER_TRADE_INTENT'
          AND de.occurred_at > now() - interval '5 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM domain_events done
            WHERE done.type = 'PAPER_TRADE_COMPLETED'
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

  const t = setInterval(() => {
    void tick();
  }, POLL_MS);
  setTimeout(() => void tick(), 1_500);

  return () => {
    stopped = true;
    clearInterval(t);
  };
}

function isAutoPaper(features: Record<string, unknown> | null): boolean {
  return isAutoPaperEntry(features);
}

async function closeSellablePosition(
  pos: SellablePaperRow,
  correlationId: string,
  exitReason: string,
): Promise<{ ok: true; pnlSol: number | null; censored?: boolean } | { ok: false; reason: string; code?: string }> {
  if (pos.entry_v_sol == null) {
    return { ok: false, reason: "missing_entry_price" };
  }
  const features = pos.entry_features ?? {};
  if (typeof features.research_strategy === "string") {
    const ts = Date.now() / 1000;
    const marked = await paperResearchCloseAtMark({ id: pos.id, reason: exitReason, ts });
    if (marked.ok) {
      if (features.session_id != null && features.research_episode != null) {
        await finishResearchEpisode(
          String(features.session_id),
          String(features.research_episode),
          "CLOSED",
          `Manual strategy-mark close; P&L ${marked.pnl.toFixed(6)} SOL`,
        );
      }
      return { ok: true, pnlSol: marked.pnl };
    }
    if (marked.code !== "STALE_MARK") {
      return { ok: false, reason: marked.reason, code: marked.code };
    }
    const reason = "CENSORED: manual close requested without a fresh strategy price";
    const censored = await paperResearchCensor({ id: pos.id, reason, ts });
    if (!censored.ok) return { ok: false, reason: censored.reason };
    if (features.session_id != null && features.research_episode != null) {
      await finishResearchEpisode(
        String(features.session_id),
        String(features.research_episode),
        "CENSORED",
        reason,
      );
    }
    return { ok: true, pnlSol: null, censored: true };
  }
  const closed = await paperClose({
    positionId: BigInt(pos.id),
    reason: exitReason,
    correlationId,
  });
  if (!closed.ok) {
    return { ok: false, reason: closed.reason, code: closed.code };
  }
  await recordOutcome({
    source: "paper",
    tradeId: BigInt(pos.id),
    entryVSol: pos.entry_v_sol,
    exitVSol: closed.data.exitPrice,
    pnlSol: closed.data.realizedPnlSol,
    pctOfSize: closed.data.pctOfSize,
    exitReason,
    holdSeconds: (Date.now() - new Date(pos.opened_at).getTime()) / 1000,
    action: ((pos.entry_features as Record<string, unknown> | null)?.action as string) ?? "MANUAL_DEMO",
    modulesAtEntry: pos.modules_at_entry,
  });
  return { ok: true, pnlSol: closed.data.realizedPnlSol };
}

async function processSellAll(
  p: IntentRow["payload"],
  correlationId: string,
): Promise<void> {
  const scope = p.scope === "auto" ? "auto" : "all";
  const sessionId =
    scope === "auto" && typeof p.session_id === "string" && p.session_id ? p.session_id : null;
  if (scope === "auto" && !sessionId) {
    await markRejected(correlationId, "missing_session_id_for_auto_scope", {});
    return;
  }

  const positions = await fetchSellableOpenPaperPositions({ sessionId });
  if (positions.length === 0) {
    await appendEvent({
      type: "PAPER_TRADE_COMPLETED",
      payload: {
        ok: true,
        side: "sell_all",
        closedCount: 0,
        failedCount: 0,
        totalPnlSol: 0,
        mints: [] as string[],
      },
      correlationId,
    }).catch(() => undefined);
    return;
  }

  let closedCount = 0;
  let failedCount = 0;
  let totalPnlSol = 0;
  const mints: string[] = [];
  const failures: Array<{ mint: string; reason: string }> = [];

  for (const pos of positions) {
    const exitReason = manualPaperExitReason(isAutoPaper(pos.entry_features), true);
    const result = await closeSellablePosition(pos, correlationId, exitReason);
    if (result.ok) {
      closedCount += 1;
      totalPnlSol += result.pnlSol ?? 0;
      mints.push(pos.mint);
      log.info("paper sell-all closed", { mint: pos.mint, pnlSol: result.pnlSol, censored: result.censored ?? false });
    } else {
      failedCount += 1;
      failures.push({ mint: pos.mint, reason: result.reason });
      log.warn("paper sell-all skip", { mint: pos.mint, reason: result.reason, code: result.code });
    }
  }

  const ok = failedCount === 0 || closedCount > 0;
  await appendEvent({
    type: "PAPER_TRADE_COMPLETED",
    payload: {
      ok,
      side: "sell_all",
      closedCount,
      failedCount,
      totalPnlSol,
      mints,
      failures: failures.length > 0 ? failures : undefined,
    },
    correlationId,
  }).catch(() => undefined);

  log.info("paper sell-all done", { closedCount, failedCount, totalPnlSol: totalPnlSol.toFixed(4) });
}

async function processIntent(r: IntentRow) {
  const correlationId = r.correlation_id;
  if (!correlationId) {
    log.warn("paper intent missing correlation_id", { id: r.id });
    return;
  }
  const p = r.payload ?? {};
  if (typeof p.strategy_id !== "string" || !p.strategy_id) {
    await markRejected(correlationId, "missing_strategy_id", { id: r.id });
    return;
  }

  if (p.side === "sell_all") {
    await processSellAll(p, correlationId);
    return;
  }

  const sessionId =
    typeof p.session_id === "string" && p.session_id ? p.session_id : null;
  const side = p.side === "buy" || p.side === "sell" ? p.side : null;
  const mint = typeof p.mint === "string" ? p.mint : "";
  if (!side || !mint) {
    await markRejected(correlationId, "invalid_payload", { id: r.id });
    return;
  }

  if (side === "buy") {
    const sizeSol = typeof p.sizeSol === "number" ? p.sizeSol : Number(p.sizeSol);
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      await markRejected(correlationId, "invalid_size", { mint });
      return;
    }
    const demo = await fetchDemoAccount();
    if (sizeSol > demo.balanceSol + 1e-9) {
      await markRejected(correlationId, "insufficient_demo_balance", {
        mint,
        balanceSol: demo.balanceSol,
        requested: sizeSol,
      });
      return;
    }
    const existing = await getDb().execute(sql`
      SELECT 1 FROM paper_positions
      WHERE state = 'OPEN' AND mint = ${mint} AND entry_features->>'ui_mode' = 'demo'
      LIMIT 1
    `);
    if ((existing as unknown as { rows: unknown[] }).rows.length > 0) {
      await markRejected(correlationId, "already_have_open_demo_position", { mint });
      return;
    }
    const opened = await paperOpen({
      mint,
      symbol: null,
      sizeSol,
      correlationId,
      entryFeatures: {
        ui_mode: "demo",
        source: p.source ?? "manual_demo_buy",
        action: "MANUAL_DEMO",
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      modulesAtEntry: {},
    });
    if (!opened.ok) {
      await markRejected(correlationId, opened.reason, { mint, code: opened.code });
      return;
    }
    await appendEvent({
      type: "PAPER_TRADE_COMPLETED",
      payload: {
        ok: true,
        side: "buy",
        tradeId: opened.data.positionId.toString(),
        entryVSol: opened.data.fillPrice,
        fillPrice: opened.data.fillPrice,
      },
      correlationId,
    }).catch(() => undefined);
    log.info("paper demo buy executed", { mint, positionId: opened.data.positionId.toString() });
    return;
  }

  const posRes = await getDb().execute(sql`
    SELECT id::text AS id,
      entry_price::float8 AS entry_v_sol,
      opened_at,
      modules_at_entry,
      entry_features
    FROM paper_positions
    WHERE state = 'OPEN'
      AND mint = ${mint}
      AND (
        entry_features->>'ui_mode' = 'demo'
        OR (
          COALESCE(entry_features->>'auto', 'false') = 'true'
          AND COALESCE(entry_features->>'session_mode', '') = 'paper'
          AND entry_features->>'shadow_of' IS NULL
          AND COALESCE(entry_features->>'purpose', '') <> 'shadow_learn'
        )
      )
    ORDER BY opened_at DESC
    LIMIT 1
  `);
  const pos = (posRes as unknown as { rows: SellablePaperRow[] }).rows[0];
  if (!pos || pos.entry_v_sol == null) {
    await markRejected(correlationId, "no_open_paper_position", { mint });
    return;
  }
  const exitReason = manualPaperExitReason(isAutoPaper(pos.entry_features), false);
  const closed = await closeSellablePosition(pos, correlationId, exitReason);
  if (!closed.ok) {
    await markRejected(correlationId, closed.reason, { mint, code: closed.code });
    return;
  }
  await appendEvent({
    type: "PAPER_TRADE_COMPLETED",
    payload: {
      ok: true,
      side: "sell",
      tradeId: pos.id,
      pnlSol: closed.pnlSol,
      censored: closed.censored ?? false,
    },
    correlationId,
  }).catch(() => undefined);
  log.info("paper sell executed", { mint, pnlSol: closed.pnlSol, censored: closed.censored ?? false, exitReason });
}

async function markRejected(
  correlationId: string,
  reason: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await appendEvent({
    type: "PAPER_TRADE_REJECTED",
    payload: { reason, ...extra },
    correlationId,
  }).catch(() => undefined);
  await appendEvent({
    type: "PAPER_TRADE_COMPLETED",
    payload: { ok: false, reason, ...extra },
    correlationId,
  }).catch(() => undefined);
}
