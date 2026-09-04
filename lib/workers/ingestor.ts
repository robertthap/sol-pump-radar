import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { env, rpcHttpUrls, rpcWssUrls } from "@/lib/env";
import { WsLogsSubscriber, type ReconnectInfo } from "@/lib/rpc/ws-manager";
import { parseProgramLogs, type ParsedPumpEvent, type ParsedCreateEvent } from "@/lib/pump/parser";
import { PUMP_BONDING_CURVE_PROGRAM, PUMP_SWAP_AMM_PROGRAM } from "@/lib/pump/program";
import { parseSwapLogs, enrichSwap, effectiveVSolFromReserves, type RawSwapEvent } from "@/lib/pump/pumpswap-parser";
import { resolvePoolInfoBatch } from "@/lib/pump/pool-registry";
import { insertEvents, insertSwapEvents, type SwapEventInsert } from "@/lib/db/repos/events";
import { ingestChartEventsFromBatch } from "@/lib/chart/data/ingestBridge";
import { upsertNewTokens } from "@/lib/db/repos/tokens";
import { processLaunchHotPipeline } from "@/lib/intelligence/launch-hot";
import { emitBusEvent } from "@/lib/arch/event-bus";
import { getIngestorStats, recordSignature } from "@/lib/rpc/stats";
import { touchWorker } from "@/lib/workers/heartbeat";
import { appendEvent } from "@spr/core";
import { insertIngestFacts } from "@/lib/db/repos/ingest-facts";
import { getDb } from "@/lib/db/client";
import { upsertWatermark, openGap, closeGap, markUnrecoverable } from "@/lib/db/repos/ingest-gaps";
import { recoverGapForMints, type AtRiskMint } from "@/lib/ingest/gap-recovery";
import { makeHttpRpcClient } from "@/lib/rpc/http-client";

const log = logger("ingestor");

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_SIZE = 100;
// Drop-audit batching: emit one INGEST_DROPPED event per N drops to avoid event spam.
const DROP_AUDIT_BATCH = 100;

export async function startIngestor() {
  const stats = getIngestorStats();
  const endpoints = rpcWssUrls();
  if (endpoints.length === 0) {
    log.error("no RPC WSS endpoints; ingestor disabled");
    stats.connState = "error";
    stats.lastError = "no endpoints";
    return () => undefined;
  }

  const buffer: ParsedPumpEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing = false;
  let droppedFromOverflow = 0;
  let droppedSinceAudit = 0;
  const MAX_BUFFER = env().MAX_INGEST_QUEUE;

  // T1.1 — high-water-mark tracking for gap recovery. Updated on every parsed
  // event; persisted on each flush (cheap upsert) so a worker restart inherits
  // the watermark from the DB and can compute its own gap.
  let hwmSlot = 0n;
  let hwmSig: string | null = null;
  let hwmTs: Date = new Date();
  // Bound: gaps wider than this are marked unrecoverable (don't hammer RPC).
  const MAX_RECOVERABLE_GAP_SEC = 300;
  // Reentrancy guard for handleReconnect (multiple rapid reconnects share one gap)
  let recoveryInFlight = false;

  async function flush(): Promise<void> {
    if (flushing) return;
    if (buffer.length === 0) return;
    flushing = true;
    const batch = buffer.splice(0, Math.min(buffer.length, 500));
    try {
      // Core ingest truth first — audit/launch paths must not block event inserts.
      const inserted = await insertEvents(batch);
      stats.eventsInserted += inserted;
      // T1.1 — persist watermark on each flush so a worker restart picks up
      // where we left off. Cheap UPSERT; idempotent and monotonic.
      if (hwmSlot > 0n) {
        upsertWatermark({ lastSlot: hwmSlot, lastSig: hwmSig, lastTs: hwmTs })
          .catch((e) => log.warn("watermark upsert failed", { err: String(e) }));
      }
      await ingestChartEventsFromBatch(batch).catch((e) =>
        log.warn("chart ingest push failed", { err: String(e) }),
      );

      const creates = batch.filter((e): e is ParsedCreateEvent => e.kind === "create");
      if (creates.length) {
        await upsertNewTokens(creates).catch((e) =>
          log.warn("token upsert failed", { err: String(e) }),
        );
      }
      await processLaunchHotPipeline(batch).catch((e) =>
        log.warn("launch-hot pipeline failed", { err: String(e) }),
      );

      try {
        const facts = await insertIngestFacts(batch);
        if (facts.deduped > 0) {
          await appendEvent({
            type: "INGEST_DEDUPED",
            payload: { deduped: facts.deduped, inserted: facts.inserted, batchSize: batch.length },
            dedupeKey: `ingest:dedupe:${Date.now() >> 10}`,
          }).catch(() => undefined);
        }
      } catch (e) {
        log.warn("ingest_facts audit failed (events still inserted)", { err: String(e) });
      }
      const createsN = batch.filter((e) => e.kind === "create").length;
      if (createsN > 0 || inserted > 0) {
        emitBusEvent({ type: "ingest:flush", at: Date.now(), creates: createsN });
      }
    } catch (e) {
      stats.lastError = "flush: " + String(e);
      log.error("flush error", { err: String(e) });
    } finally {
      flushing = false;
      if (buffer.length > 0) scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch((e) => log.error("flush rejected", { err: String(e) }));
    }, FLUSH_INTERVAL_MS);
  }

  // T1.1 — handleReconnect: compute the gap from prev HWM → current chain head,
  // scope at-risk mints (snapshots overlapping the gap + open positions), kick
  // recovery via the per-PDA signature replay, insert recovered events through
  // the normal path (chart WS skipped — backfill must not stream).
  async function handleReconnect(info: ReconnectInfo): Promise<void> {
    if (recoveryInFlight) {
      log.info("ws reconnect during in-flight recovery — coalescing into one gap");
      return;
    }
    recoveryInFlight = true;
    const fromSlot = BigInt(info.lastSlot);
    const fromTs = info.lastTs;
    const httpUrls = rpcHttpUrls();
    if (!httpUrls.length) {
      log.warn("ws reconnect: no HTTP RPC for recovery; skipping");
      recoveryInFlight = false;
      return;
    }
    const rpc = makeHttpRpcClient(httpUrls[0]!);
    // Discover current chain head via getSlot; if RPC is unhappy, bail.
    let toSlot = fromSlot;
    try {
      const res = await fetch(httpUrls[0]!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      });
      const j = (await res.json()) as { result?: number };
      if (typeof j.result === "number" && j.result > Number(fromSlot)) toSlot = BigInt(j.result);
    } catch (e) {
      log.warn("getSlot failed on reconnect; cannot compute gap", { err: String(e) });
      recoveryInFlight = false;
      return;
    }
    const toTs = new Date();
    const gapSec = (toTs.getTime() - fromTs.getTime()) / 1000;
    log.info("ws reconnect — gap detected", {
      fromSlot: fromSlot.toString(),
      toSlot: toSlot.toString(),
      gapSec: gapSec.toFixed(1),
    });

    let gapId: bigint;
    try {
      gapId = await openGap({
        startedSlot: fromSlot, endedSlot: toSlot,
        startedTs: fromTs, endedTs: toTs,
        scope: gapSec > MAX_RECOVERABLE_GAP_SEC ? "unrecoverable" : "tracked",
        note: gapSec > MAX_RECOVERABLE_GAP_SEC ? `gap ${gapSec.toFixed(0)}s exceeds cap` : undefined,
      });
    } catch (e) {
      log.warn("openGap failed; skipping recovery", { err: String(e) });
      recoveryInFlight = false;
      return;
    }
    if (gapSec > MAX_RECOVERABLE_GAP_SEC) {
      log.warn("gap too long; marked unrecoverable", { gapSec: gapSec.toFixed(1), cap: MAX_RECOVERABLE_GAP_SEC });
      recoveryInFlight = false;
      return;
    }

    // At-risk mints: snapshots whose horizons overlap + open paper positions.
    // Both restricted to mints we have a create event for (so we know the PDA).
    let mints: AtRiskMint[];
    try {
      const fromIso = fromTs.toISOString();
      const toIso = toTs.toISOString();
      const res = await getDb().execute(sql`
        WITH at_risk AS (
          SELECT DISTINCT mint FROM feature_snapshots fs
          LEFT JOIN outcome_labels ol ON ol.snapshot_id = fs.id
          WHERE fs.ts <= ${toIso}::timestamptz
            AND fs.ts + interval '6 hours' >= ${fromIso}::timestamptz
            AND (ol.id IS NULL OR ol.horizons_complete = false)
          UNION
          SELECT mint FROM paper_positions WHERE state = 'OPEN'
        )
        SELECT atr.mint::text AS mint, ev.raw->>'bondingCurve' AS pda
        FROM at_risk atr
        JOIN LATERAL (
          SELECT raw FROM events
          WHERE mint = atr.mint AND kind = 'create' AND raw->>'bondingCurve' IS NOT NULL
          LIMIT 1
        ) ev ON true
      `);
      type Row = { mint: string; pda: string };
      mints = (res as unknown as { rows: Row[] }).rows.map((r) => ({ mint: r.mint, bondingCurvePda: r.pda }));
    } catch (e) {
      log.warn("at-risk mint query failed", { err: String(e) });
      mints = [];
    }
    log.info("gap recovery scope", { atRiskMints: mints.length });

    if (mints.length === 0) {
      await closeGap(gapId, 0, "no at-risk mints").catch(() => undefined);
      recoveryInFlight = false;
      return;
    }

    // Background — must not block live ingestion.
    void (async () => {
      try {
        const r = await recoverGapForMints(
          rpc,
          { fromSlot, toSlot, untilSig: info.lastSig },
          mints,
        );
        if (r.events.length > 0) {
          // Backfilled events go ONLY through insertEvents — skip chart push,
          // tokens upsert, launch-hot, etc. (they'd trip the chart's
          // sanitizeAscending guard on stale slots, and the rest are live-only paths).
          await insertEvents(r.events).catch((e) => log.warn("recovered-events insert failed", { err: String(e) }));
        }
        await closeGap(gapId, r.events.length, r.failedMints.length > 0 ? `failed: ${r.failedMints.length}` : undefined);
        log.info("gap recovery complete", {
          recovered: r.events.length, atRiskMints: mints.length, failedMints: r.failedMints.length,
        });
      } catch (e) {
        log.warn("gap recovery failed", { err: String(e) });
        await markUnrecoverable(gapId, "recovery threw").catch(() => undefined);
      } finally {
        recoveryInFlight = false;
      }
    })();
  }

  const sub = new WsLogsSubscriber(endpoints, PUMP_BONDING_CURVE_PROGRAM, (n) => {
    recordSignature();
    if (n.err) return;
    if (!n.signature || !n.logs) return;
    // T1.1 — track HWM as we see notifications, regardless of parse success.
    if (n.slot && n.slot > Number(hwmSlot)) {
      hwmSlot = BigInt(n.slot);
      hwmSig = n.signature ?? null;
      hwmTs = new Date();
    }
    let parsed: ParsedPumpEvent[];
    try {
      // Live WS gives us no chain blockTime — the fallback is our receive clock.
      parsed = parseProgramLogs(
        n.logs, n.signature, BigInt(n.slot ?? 0), Math.floor(Date.now() / 1000), "local",
      );
    } catch (e) {
      stats.decodeErrors++;
      stats.lastError = "decode: " + String(e);
      return;
    }
    if (parsed.length === 0) return;
    stats.eventsParsed += parsed.length;
    if (buffer.length + parsed.length > MAX_BUFFER) {
      droppedFromOverflow += parsed.length;
      droppedSinceAudit += parsed.length;
      if (droppedSinceAudit >= DROP_AUDIT_BATCH) {
        const batchSize = droppedSinceAudit;
        droppedSinceAudit = 0;
        log.warn("buffer overflow; dropping events", { droppedTotal: droppedFromOverflow });
        // Best-effort audit; never throws into the WS callback path.
        void appendEvent({
          type: "INGEST_DROPPED",
          payload: {
            dropped: batchSize,
            droppedTotal: droppedFromOverflow,
            queueDepth: buffer.length,
            maxQueue: MAX_BUFFER,
            at: Date.now(),
          },
        }).catch(() => undefined);
      }
      return;
    }
    buffer.push(...parsed);
    if (buffer.length >= FLUSH_BATCH_SIZE) flush();
    else scheduleFlush();
  }, (info) => {
    // T1.1 — fire-and-forget; handleReconnect manages its own reentrancy.
    void handleReconnect(info).catch((e) => log.warn("handleReconnect crashed", { err: String(e) }));
  });

  sub.start();
  touchWorker("ingestor");

  // ===== T1.2 — PumpSwap (post-graduation DEX) ingestion (env-gated) =====
  // Separate subscriber on the PumpSwap AMM program (logsSubscribe takes one
  // `mentions` filter → a second instance, not a wider filter). Raw swap events
  // are buffered, then resolved (pool→mint, cached) + enriched (effective vSol)
  // in batches during flush, so the WS callback never blocks on RPC.
  let swapSub: WsLogsSubscriber | null = null;
  let swapFlushTimer: NodeJS.Timeout | null = null;
  if (env().PUMPSWAP_INGEST === "on") {
    const swapBuffer: RawSwapEvent[] = [];
    let swapFlushing = false;

    async function flushSwaps(): Promise<void> {
      if (swapFlushing || swapBuffer.length === 0) return;
      swapFlushing = true;
      const batch = swapBuffer.splice(0, Math.min(swapBuffer.length, 300));
      try {
        // Resolve all distinct pools in this batch (cached forever after first hit).
        const pools = batch.map((r) => r.pool);
        const poolInfo = await resolvePoolInfoBatch(pools);
        const rows: SwapEventInsert[] = [];
        for (const raw of batch) {
          const info = poolInfo.get(raw.pool);
          if (!info) continue; // unresolved pool (not WSOL-paired, or RPC miss) — skip
          const e = enrichSwap(raw, info);
          const vSol = effectiveVSolFromReserves(e.solReserveAfter, e.tokenReserveAfter);
          if (vSol == null) continue;
          rows.push({
            signature: e.signature,
            // logIndex disambiguates multiple swap events in one tx for the
            // (signature, instruction_index) unique constraint.
            instructionIndex: raw.logIndex,
            slot: e.slot,
            blockTime: e.blockTime,
            mint: e.mint,
            wallet: e.wallet,
            side: e.side,
            solAmount: e.solAmount,
            tokenAmount: e.tokenAmount / 1e6, // raw → whole tokens (pump 6 decimals)
            vSolAfter: vSol,
            pool: e.pool,
            tsSource: e.tsSource,
          });
        }
        if (rows.length) {
          const n = await insertSwapEvents(rows);
          stats.eventsInserted += n;
        }
      } catch (e) {
        log.warn("swap flush error", { err: String(e) });
      } finally {
        swapFlushing = false;
      }
    }
    function scheduleSwapFlush() {
      if (swapFlushTimer) return;
      swapFlushTimer = setTimeout(() => {
        swapFlushTimer = null;
        flushSwaps().catch((e) => log.error("swap flush rejected", { err: String(e) }));
      }, FLUSH_INTERVAL_MS);
    }

    swapSub = new WsLogsSubscriber(endpoints, PUMP_SWAP_AMM_PROGRAM, (n) => {
      if (n.err || !n.signature || !n.logs) return;
      let raws: RawSwapEvent[];
      try {
        // Live WS gives us no chain blockTime — the fallback is our receive clock.
        raws = parseSwapLogs(
          n.logs, n.signature, BigInt(n.slot ?? 0), Math.floor(Date.now() / 1000), "local",
        );
      } catch {
        stats.decodeErrors++;
        return;
      }
      if (!raws.length) return;
      if (swapBuffer.length + raws.length > MAX_BUFFER) return; // backpressure
      swapBuffer.push(...raws);
      if (swapBuffer.length >= FLUSH_BATCH_SIZE) flushSwaps();
      else scheduleSwapFlush();
    });
    swapSub.start();
    log.info("PumpSwap ingestion enabled (venue=pumpswap)");
  }

  const decayTimer = setInterval(() => {
    const s = getIngestorStats();
    const nextBucket = (Math.floor(Date.now() / 1000) + 1) % s.bySecond.length;
    s.bySecond[nextBucket] = 0;
  }, 1000);

  const statsTimer = setInterval(() => {
    const uptimeSec = Math.max(1, (Date.now() - stats.startedAt) / 1000);
    log.info("ingestor stats", {
      conn: stats.connState,
      endpoint: stats.endpoint,
      sigs: stats.signaturesSeen,
      parsed: stats.eventsParsed,
      inserted: stats.eventsInserted,
      reconnects: stats.reconnects,
      sigsPerSecAvg: (stats.signaturesSeen / uptimeSec).toFixed(2),
    });
    touchWorker("ingestor");
  }, 30_000);

  return async () => {
    clearInterval(statsTimer);
    clearInterval(decayTimer);
    if (flushTimer) clearTimeout(flushTimer);
    if (swapFlushTimer) clearTimeout(swapFlushTimer);
    sub.stop();
    if (swapSub) swapSub.stop();
    await flush().catch(() => undefined);
  };
}
