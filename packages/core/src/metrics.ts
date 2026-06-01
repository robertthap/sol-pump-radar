export type WorkerMetricsSnapshot = {
  at: number;
  queueDepth: number;
  dropsTotal: number;
  lastFlushMs: number | null;
  flushCount: number;
  intelTicks: number;
  executionIntents: number;
};

const state = {
  queueDepth: 0,
  dropsTotal: 0,
  lastFlushMs: null as number | null,
  flushCount: 0,
  intelTicks: 0,
  executionIntents: 0,
};

export function setQueueDepth(n: number) {
  state.queueDepth = n;
}

export function recordDrop() {
  state.dropsTotal++;
}

export function recordFlush(ms: number) {
  state.lastFlushMs = ms;
  state.flushCount++;
}

export function recordIntelTick() {
  state.intelTicks++;
}

export function recordExecutionIntent() {
  state.executionIntents++;
}

export function snapshot(): WorkerMetricsSnapshot {
  return {
    at: Date.now(),
    queueDepth: state.queueDepth,
    dropsTotal: state.dropsTotal,
    lastFlushMs: state.lastFlushMs,
    flushCount: state.flushCount,
    intelTicks: state.intelTicks,
    executionIntents: state.executionIntents,
  };
}

export function formatMetricsLine(s: WorkerMetricsSnapshot): string {
  return `[metrics] q=${s.queueDepth} drops=${s.dropsTotal} lastFlushMs=${s.lastFlushMs ?? "n/a"} flushes=${s.flushCount} intel=${s.intelTicks} exec=${s.executionIntents}`;
}
