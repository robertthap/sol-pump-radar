import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { env, rpcHttpUrls, rpcWssUrls } from "@/lib/env";
import { WsLogsSubscriber, type ReconnectInfo } from "@/lib/rpc/ws-manager";
import { parseProgramLogs, type ParsedPumpEvent, type ParsedCreateEvent } from "@/lib/pump/parser";
import { PUMP_BONDING_CURVE_PROGRAM, PUMP_SWAP_AMM_PROGRAM } from "@/lib/pump/program";
import { parseSwapLogs, enrichSwap, effectiveVSolFromReserves, type RawSwapEvent } from "@/lib/pump/pumpswap-parser";
import { isPoolResolutionPending, resolvePoolInfoBatch } from "@/lib/pump/pool-registry";
import { insertEvents, insertSwapEvents, type SwapEventInsert } from "@/lib/db/repos/events";
import { upsertNewTokens } from "@/lib/db/repos/tokens";
import { processLaunchHotPipeline } from "@/lib/intelligence/launch-hot";
import { emitBusEvent } from "@/lib/arch/event-bus";
import { getIngestorStats, recordSignature } from "@/lib/rpc/stats";
import { touchWorker } from "@/lib/workers/heartbeat";
import { appendEvent } from "@spr/core";
import { insertIngestFacts } from "@/lib/db/repos/ingest-facts";
import { getDb } from "@/lib/db/client";
import { upsertWatermark, openGap, closeGap, markUnrecoverable } from "@/lib/db/repos/ingest-gaps";
import { recoverGapForMints, shouldCloseGap, type AtRiskMint } from "@/lib/ingest/gap-recovery";
import { advanceWatermark, batchWatermark, commitBatch, peekBatch } from "@/lib/workers/flush-queue";
import { makeHttpRpcClient } from "@/lib/rpc/http-client";

const log = logger("ingestor");

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_SIZE = 100;
// Drop-audit batching: emit one INGEST_DROPPED event per N drops to avoid event spam.
const DROP_AUDIT_BATCH = 100;
const SWAP_RESOLUTION_MAX_ATTEMPTS = 8;
const SWAP_RESOLUTION_MAX_AGE_MS = 30_000;

function swapEventKey(raw: RawSwapEvent): string {
  return `${raw.signature}:${raw.logIndex}`;
}

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
    const flushStartedAt = Date.now();
    // H07 — PEEK, do not splice. The batch stays in the buffer until the insert
    // commits, so a database failure cannot drop it on the floor.
    const batch = peekBatch(buffer, 500);
    let committed = false;
    try {
      // Core ingest truth first — audit/launch paths must not block event inserts.
      const inserted = await insertEvents(batch);
      committed = true;
      commitBatch(buffer, batch.length);
      stats.eventsInserted += inserted;
      // H07 — the watermark advances ONLY to what this commit actually covered,
      // and never backwards. Awaited: a watermark that silently failed to
      // persist would re-open the same window on restart.
      const mark = advanceWatermark(
        hwmSlot > 0n ? { slot: hwmSlot, sig: hwmSig, ts: hwmTs } : null,
        batchWatermark(batch, new Date()),
      );
      if (mark && mark.slot > 0n) {
        hwmSlot = mark.slot; hwmSig = mark.sig; hwmTs = mark.ts;
        await upsertWatermark({ lastSlot: mark.slot, lastSig: mark.sig, lastTs: mark.ts })
          .catch((e) => log.warn("watermark upsert failed", { err: String(e) }));
      }

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
      // H07 — the insert never committed, so the batch is still in the buffer
      // and will be retried. Only an insert that threw BEFORE commitBatch can
      // reach here with the events still queued; nothing is lost.
      if (!committed && batch.length) {
        log.warn("flush failed; batch retained for retry", { batch: batch.length, queued: buffer.length });
      }
    } finally {
      // decoded -> persisted (T1 -> T2). The whole chain is serialized behind
      // `flushing`, so this duration is exactly what backs the buffer up.
      const flushMs = Date.now() - flushStartedAt;
      stats.flushMsLast = flushMs;
      if (flushMs > stats.flushMsMax) stats.flushMsMax = flushMs;
      stats.flushes += 1;
      stats.bufferCapacity = MAX_BUFFER;
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
        // H04 — the insert's success decides whether anything was recovered.
        // This used to swallow the error and then close the gap reporting the
        // full count, so a failed insert produced a CLOSED gap over events that
        // were never written. A closed gap is never retried.
        let insertSucceeded = true;
        if (r.events.length > 0) {
          // Backfilled events go ONLY through insertEvents — skip chart push,
          // tokens upsert, launch-hot, etc. (they'd trip the chart's
          // sanitizeAscending guard on stale slots, and the rest are live-only paths).
          insertSucceeded = await insertEvents(r.events).then(
            () => true,
            (e) => { log.warn("recovered-events insert failed", { err: String(e) }); return false; },
          );
        }
        const detail = {
          recovered: r.events.length, atRiskMints: mints.length,
          failedMints: r.failedMints.length, truncatedMints: r.truncatedMints.length,
          insertSucceeded,
        };
        if (shouldCloseGap(r, insertSucceeded)) {
          await closeGap(gapId, r.events.length);
          log.info("gap recovery complete", detail);
        } else {
          // Left OPEN deliberately: a partial, truncated or unsaved recovery is
          // a gap we still have. Closing it here would make the hole permanent
          // and invisible to the mechanism that exists to find it.
          log.warn("gap recovery incomplete; gap left OPEN for retry", detail);
        }
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
    // H07 — seeing a notification is NOT storing it. This used to advance the
    // persisted watermark at decode time, so a failed flush left the watermark
    // covering events that were never written, and gap recovery (which starts
    // from the watermark) could not see the hole it exists to find. The
    // watermark now moves only in flush(), after the insert commits.
    let parsed: ParsedPumpEvent[];
    const receivedAt = Date.now();
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
    // received -> decoded (T0 -> T1).
    const decodeMs = Date.now() - receivedAt;
    stats.decodeMsLast = decodeMs;
    if (decodeMs > stats.decodeMsMax) stats.decodeMsMax = decodeMs;
    stats.eventsParsed += parsed.length;
    if (buffer.length + parsed.length > MAX_BUFFER) {
      droppedFromOverflow += parsed.length;
      // Mirror onto the shared stats object so /api/stats/ingestor can SEE the loss.
      stats.eventsDropped = droppedFromOverflow;
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
    if (buffer.length > stats.bufferDepthMax) stats.bufferDepthMax = buffer.length;
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
    const swapResolutionRetries = new Map<string, { attempts: number; firstSeenAt: number }>();
    let swapFlushing = false;

    async function flushSwaps(): Promise<void> {
      if (swapFlushing || swapBuffer.length === 0) return;
      swapFlushing = true;
      // Drain rate has to beat the AMM firehose (~200 swaps/s measured), or the
      // buffer saturates and whole pools disappear from the tape.
      const batch = swapBuffer.splice(0, Math.min(swapBuffer.length, 1000));
      const retry: RawSwapEvent[] = [];
      try {
        // Resolve all distinct pools in this batch (cached forever after first hit).
        const pools = batch.map((r) => r.pool);
        const poolInfo = await resolvePoolInfoBatch(pools);
        const rows: SwapEventInsert[] = [];
        for (const raw of batch) {
          const info = poolInfo.get(raw.pool);
          const key = swapEventKey(raw);
          if (!info) {
            if (isPoolResolutionPending(raw.pool)) {
              const previous = swapResolutionRetries.get(key);
              const state = {
                attempts: (previous?.attempts ?? 0) + 1,
                firstSeenAt: previous?.firstSeenAt ?? Date.now(),
              };
              if (
                state.attempts <= SWAP_RESOLUTION_MAX_ATTEMPTS &&
                Date.now() - state.firstSeenAt <= SWAP_RESOLUTION_MAX_AGE_MS
              ) {
                swapResolutionRetries.set(key, state);
                retry.push(raw);
              } else {
                swapResolutionRetries.delete(key);
                stats.eventsDropped++;
              }
            } else {
              // Definitive non-WSOL/non-PumpSwap result; it cannot become useful.
              swapResolutionRetries.delete(key);
            }
            continue;
          }
          swapResolutionRetries.delete(key);
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
        if (retry.length > 0) {
          // Put the graduation-critical first swaps ahead of newer traffic. They
          // retain their original chain/local timestamp, so a successful retry
          // reconstructs the +1s..+5s decision tape without look-ahead data.
          const room = Math.max(0, MAX_BUFFER - swapBuffer.length);
          const kept = retry.slice(0, room);
          swapBuffer.unshift(...kept);
          if (kept.length < retry.length) {
            const dropped = retry.length - kept.length;
            stats.eventsDropped += dropped;
            for (const raw of retry.slice(kept.length)) {
              swapResolutionRetries.delete(swapEventKey(raw));
            }
            log.warn("PumpSwap retry buffer full; dropping unresolved swaps", { dropped });
          }
        }
        swapFlushing = false;
        // A flush drains at most 1000 events. Without this the remainder waited
        // for a new WS message to reschedule it, so a backlog that outran the
        // stream simply sat there — same stall the curve `flush()` avoids.
        if (swapBuffer.length > 0) scheduleSwapFlush();
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
      if (swapBuffer.length + raws.length > MAX_BUFFER) {
        // Counted, not silent: the curve path reports its drops and this one did
        // not, so a saturated swap buffer looked identical to a quiet market.
        stats.eventsDropped += raws.length;
        return;
      }
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
      dropped: stats.eventsDropped,
      decodeMsMax: stats.decodeMsMax,
      flushMsLast: stats.flushMsLast,
      flushMsMax: stats.flushMsMax,
      bufferDepthMax: `${stats.bufferDepthMax}/${MAX_BUFFER}`,
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
