import "server-only";

export type HotSource = "INGESTOR" | "EVENT" | "CONTINUATION" | "MANUAL";
export type HotState = "HOT_LAUNCH" | "HOT";

type HotEntry = {
  until: number;
  score: number;
  source: HotSource;
  state: HotState;
};

const entries = new Map<string, HotEntry>();

const DEFAULT_TTL_MS = 120_000;

export function markMintHot(
  mint: string,
  opts?: number | { ttlMs?: number; score?: number; source?: HotSource; state?: HotState },
): void {
  const o = typeof opts === "number" ? { ttlMs: opts } : (opts ?? {});
  const existing = entries.get(mint);
  const score = Math.max(existing?.score ?? 0, o.score ?? 0.55);
  entries.set(mint, {
    until: Date.now() + (o.ttlMs ?? DEFAULT_TTL_MS),
    score,
    source: o.source ?? "EVENT",
    state: o.state ?? "HOT",
  });
}

export function markLaunchHot(mint: string, score: number, ttlMs?: number): void {
  const existing = entries.get(mint);
  if (existing && existing.source === "INGESTOR" && existing.score >= score) {
    existing.until = Math.max(existing.until, Date.now() + (ttlMs ?? 18_000));
    return;
  }
  entries.set(mint, {
    until: Date.now() + (ttlMs ?? 18_000),
    score: Math.min(1, Math.max(0, score)),
    source: "INGESTOR",
    state: "HOT_LAUNCH",
  });
}

export function markMintsHot(mints: string[], ttlMs = DEFAULT_TTL_MS): void {
  for (const m of mints) markMintHot(m, { ttlMs, score: 0.55, source: "CONTINUATION" });
}

/** Ranked hot entries (expired pruned). */
export function getHotMintScores(now = Date.now()): Array<{
  mint: string;
  score: number;
  source: HotSource;
  state: HotState;
}> {
  const out: Array<{ mint: string; score: number; source: HotSource; state: HotState }> = [];
  for (const [mint, e] of entries) {
    if (e.until < now) {
      entries.delete(mint);
      continue;
    }
    out.push({ mint, score: e.score, source: e.source, state: e.state });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function getHotMints(now = Date.now()): Set<string> {
  return new Set(getHotMintScores(now).map((h) => h.mint));
}

export function isMintHot(mint: string, now = Date.now()): boolean {
  const e = entries.get(mint);
  if (!e) return false;
  if (e.until < now) {
    entries.delete(mint);
    return false;
  }
  return true;
}

/** Launch-only hot mints capped by score (does not include continuation/event hot). */
export function getTopLaunchHotMints(max: number, now = Date.now()): string[] {
  return getHotMintScores(now)
    .filter((h) => h.state === "HOT_LAUNCH" && h.source === "INGESTOR")
    .slice(0, max)
    .map((h) => h.mint);
}
