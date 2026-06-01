import "server-only";

type Sample = { label: string; ms: number; at: number };

const samples: Sample[] = [];
const MAX = 80;
const SLOW_MS = 120;

export function recordQuery(label: string, ms: number): void {
  if (ms >= SLOW_MS) {
    samples.push({ label, ms, at: Date.now() });
    if (samples.length > MAX) samples.shift();
    void import("@/lib/runtime/perf-tracker").then(({ notePerf }) =>
      notePerf(`slow query ${label} ${ms}ms`),
    );
  }
}

export async function timedQuery<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    recordQuery(label, Date.now() - t0);
  }
}

export function getSlowQuerySamples(limit = 15) {
  return samples.slice(-limit).reverse();
}
