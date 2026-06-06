import "server-only";
import { logger } from "@/lib/log";
import { env, rpcWssUrls } from "@/lib/env";
import { WsLogsSubscriber } from "@/lib/rpc/ws-manager";
import { parseProgramLogs, type ParsedPumpEvent, type ParsedCreateEvent } from "@/lib/pump/parser";
import { PUMP_BONDING_CURVE_PROGRAM } from "@/lib/pump/program";
import { insertEvents } from "@/lib/db/repos/events";
import { ingestChartEventsFromBatch } from "@/lib/chart/data/ingestBridge";
import { upsertNewTokens } from "@/lib/db/repos/tokens";
import { processLaunchHotPipeline } from "@/lib/intelligence/launch-hot";
import { emitBusEvent } from "@/lib/arch/event-bus";
import { getIngestorStats, recordSignature } from "@/lib/rpc/stats";
import { touchWorker } from "@/lib/workers/heartbeat";
import { appendEvent } from "@spr/core";
import { insertIngestFacts } from "@/lib/db/repos/ingest-facts";

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

  async function flush(): Promise<void> {
    if (flushing) return;
    if (buffer.length === 0) return;
    flushing = true;
    const batch = buffer.splice(0, Math.min(buffer.length, 500));
    try {
      // Core ingest truth first — audit/launch paths must not block event inserts.
      const inserted = await insertEvents(batch);
      stats.eventsInserted += inserted;
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

  const sub = new WsLogsSubscriber(endpoints, PUMP_BONDING_CURVE_PROGRAM, (n) => {
    recordSignature();
    if (n.err) return;
    if (!n.signature || !n.logs) return;
    let parsed: ParsedPumpEvent[];
    try {
      parsed = parseProgramLogs(n.logs, n.signature, BigInt(n.slot ?? 0), Math.floor(Date.now() / 1000));
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
  });

  sub.start();
  touchWorker("ingestor");

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
    sub.stop();
    await flush().catch(() => undefined);
  };
}
