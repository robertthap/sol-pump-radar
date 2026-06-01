import "server-only";

/**
 * Postgres handles concurrency natively via pg.Pool. This module is retained
 * only to keep diagnostics endpoints stable; new code should not call enqueueDbWrite.
 */

let queued = 0;
let completed = 0;
let lastWaitMs = 0;

export function enqueueDbWrite<T>(_label: string, fn: () => Promise<T>): Promise<T> {
  queued++;
  const t0 = Date.now();
  return fn().finally(() => {
    completed++;
    lastWaitMs = Date.now() - t0;
  });
}

export function getWriteQueueStats() {
  return { queued, completed, lastWaitMs };
}
