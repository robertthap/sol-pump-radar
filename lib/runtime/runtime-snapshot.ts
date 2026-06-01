import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { env, rpcHttpUrls } from "@/lib/env";
import { readState } from "@/lib/circuit-breaker/state";
import { getIngestorStats } from "@/lib/rpc/stats";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";

function rpcScore(stats: ReturnType<typeof getIngestorStats>, now: number): {
  score: number;
  issues: string[];
} {
  const issues: string[] = [];
  let score = 100;
  if (stats.connState !== "subscribed") {
    issues.push(`conn_${stats.connState}`);
    score -= 40;
  }
  if (stats.lastMessageAt == null) {
    issues.push("no_messages");
    score -= 30;
  } else {
    const ageSec = Math.round((now - stats.lastMessageAt) / 1000);
    if (ageSec > 30) {
      issues.push(`stale_${ageSec}s`);
      score -= Math.min(40, ageSec);
    }
  }
  if (stats.reconnects > 3) {
    issues.push(`reconnects_${stats.reconnects}`);
    score -= Math.min(20, stats.reconnects * 2);
  }
  if (stats.lastError) {
    issues.push("last_error");
    score -= 15;
  }
  return { score: Math.max(0, Math.min(100, score)), issues };
}

async function sampleRpcLatencyMs(): Promise<number | null> {
  const url = rpcHttpUrls()[0];
  if (!url) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    return Date.now() - t0;
  } catch {
    return null;
  }
}

export async function captureRuntimeSnapshot(): Promise<void> {
  const e = env();
  const now = Date.now();
  const stats = getIngestorStats();
  const cb = await readState();
  const rpc = rpcScore(stats, now);
  const latencyMs = await sampleRpcLatencyMs();
  if (latencyMs != null && latencyMs > 800) rpc.issues.push(`latency_${latencyMs}ms`);

  const counts = await getDb().execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM paper_positions WHERE state = 'OPEN') AS paper_open,
      (SELECT COUNT(*)::int FROM live_trades WHERE status = 'open') AS live_open,
      (SELECT COUNT(*)::int FROM worker_heartbeat
        WHERE EXTRACT(EPOCH FROM (now() - last_beat)) * 1000 > ${e.WORKER_HEARTBEAT_TIMEOUT_MS}
      ) AS stale_hb
  `);
  type C = { paper_open: number; live_open: number; stale_hb: number };
  const c = (counts as unknown as { rows: C[] }).rows[0] ?? {
    paper_open: 0,
    live_open: 0,
    stale_hb: 0,
  };

  const session = await getActiveSession().catch(() => null);
  const lastEventAgeSec =
    stats.lastMessageAt != null ? Math.round((now - stats.lastMessageAt) / 1000) : null;

  const payload = {
    ingest: {
      drops1h: null as number | null,
      lastEventAgeSec,
      queueMax: e.MAX_INGEST_QUEUE,
      connState: stats.connState,
    },
    workers: { staleHeartbeatCount: c.stale_hb },
    sessions: session
      ? { activeAutoSessionId: String(session.id), mode: session.mode }
      : null,
    positions: { openPaper: c.paper_open, openLive: c.live_open },
    rpc: {
      reconnectCount: stats.reconnects,
      lastMessageAgeSec: lastEventAgeSec,
      latencyMs,
      rpcScore: rpc.score,
      rpcIssues: rpc.issues,
    },
    memory: { heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) },
    circuitBreaker: cb.state,
  };

  await getDb().execute(sql`
    INSERT INTO runtime_snapshots (payload) VALUES (${JSON.stringify(payload)}::jsonb)
  `);

  const retentionDays = Number(process.env.RUNTIME_SNAPSHOT_RETENTION_DAYS ?? 7);
  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    await getDb().execute(sql`
      DELETE FROM runtime_snapshots
      WHERE captured_at < now() - (${retentionDays}::int || ' days')::interval
    `);
  }
}

export function startRuntimeSnapshotWriter(): () => void {
  const TICK_MS = 30_000;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void captureRuntimeSnapshot()
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  };
  const id = setInterval(tick, TICK_MS);
  setTimeout(tick, 5_000);
  return () => clearInterval(id);
}
