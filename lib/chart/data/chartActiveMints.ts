import "server-only";

/** Mints with a recent chart API request — polled for DEX quotes even without WS. */
const lastSeen = new Map<string, number>();

export function markChartActive(mint: string, nowMs = Date.now()): void {
  if (!mint || mint.length < 32) return;
  lastSeen.set(mint, nowMs);
}

export function getChartActiveMints(maxAgeMs = 120_000, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const [mint, at] of lastSeen) {
    if (nowMs - at <= maxAgeMs) out.push(mint);
    else lastSeen.delete(mint);
  }
  return out;
}
