import "server-only";

type WorkerBeat = { at: number; lastTickMs?: number };

declare global {
  // eslint-disable-next-line no-var
  var __spr_worker_hb__: Map<string, WorkerBeat> | undefined;
}

function hbMap(): Map<string, WorkerBeat> {
  if (!globalThis.__spr_worker_hb__) {
    globalThis.__spr_worker_hb__ = new Map();
  }
  return globalThis.__spr_worker_hb__;
}

/** In-process heartbeat + Postgres mirror (web reads DB via /api/runtime/health). */
export function touchWorker(name: string, opts?: { tickMs?: number }) {
  const map = hbMap();
  const prev = map.get(name);
  const beat: WorkerBeat = {
    at: Date.now(),
    lastTickMs: opts?.tickMs ?? prev?.lastTickMs,
  };
  map.set(name, beat);
  void import("@/lib/runtime/worker-heartbeat-db").then((m) =>
    m.touchWorkerDb(name, opts?.tickMs).catch(() => undefined),
  );
}

export function getWorkerHeartbeats(): Record<string, number> {
  const mem = hbMap();
  return Object.fromEntries([...mem.entries()].map(([k, v]) => [k, v.at]));
}

export function getWorkerLastTickMs(): Record<string, number> {
  const mem = hbMap();
  const out: Record<string, number> = {};
  for (const [k, v] of mem) {
    if (v.lastTickMs != null) out[k] = v.lastTickMs;
  }
  return out;
}

export function touchOrchestratorBoot() {
  touchWorker("orchestrator");
}
