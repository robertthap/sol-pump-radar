/**
 * Measured execution latency (M05) — PURE, no IO.
 *
 * Paper filled at `80 + random() * 200` ms. That range is not a measurement of
 * anything: it was a plausible-looking guess, and it is the single number that
 * decides how much of a move a paper fill is allowed to capture. Too low and
 * every result is optimistic in exactly the way that makes a dead strategy look
 * alive, which is the failure this audit exists to prevent.
 *
 * Latency here is the whole path from the market event to the fill landing:
 *
 *   ingest   event seen on the wire -> decoded                 (decodeMs)
 *   persist  decoded -> committed and visible to the trader    (flushMs)
 *   decide   visible -> the trader's tick evaluates it         (tickMs)
 *   submit   decision -> the transaction lands                 (submitMs)
 *
 * The stages are kept SEPARATE rather than summed into one number, because the
 * point of measuring is to find which one dominates — and three of the four are
 * things this system controls.
 */

export type LatencyStage = "ingest" | "persist" | "decide" | "submit";

export type StageSamples = Record<LatencyStage, number[]>;

export type Percentiles = { p50: number; p90: number; p99: number; n: number };

/**
 * Nearest-rank percentile on sorted samples.
 *
 * Nearest-rank, not interpolated: every reported value is one that actually
 * occurred, which is what you want when the number will be used as a delay.
 */
export function percentiles(samples: readonly number[]): Percentiles | null {
  const clean = samples.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const at = (q: number) => clean[Math.min(clean.length - 1, Math.ceil(q * clean.length) - 1)]!;
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), n: clean.length };
}

export type LatencyProfile = {
  stages: Partial<Record<LatencyStage, Percentiles>>;
  total: Percentiles | null;
  /** The stage contributing the most at p50, and its share of the total. */
  bottleneck: { stage: LatencyStage; p50Ms: number; shareOfTotal: number } | null;
  /** False when any stage had no samples — the profile is then incomplete. */
  complete: boolean;
};

const STAGES: LatencyStage[] = ["ingest", "persist", "decide", "submit"];

/**
 * Build a profile from per-stage samples.
 *
 * The total is the per-observation SUM, not the sum of the per-stage
 * percentiles: p99 of a sum is not the sum of the p99s, and treating it that
 * way overstates the tail badly. Where stage sample counts differ, the total is
 * computed over however many complete observations exist.
 */
export function latencyProfile(samples: Partial<StageSamples>): LatencyProfile {
  const stages: Partial<Record<LatencyStage, Percentiles>> = {};
  for (const stage of STAGES) {
    const p = percentiles(samples[stage] ?? []);
    if (p) stages[stage] = p;
  }
  const complete = STAGES.every((s) => stages[s] != null);

  const observations = Math.min(
    ...STAGES.map((s) => (samples[s] ?? []).length).filter((n) => n > 0),
    Number.POSITIVE_INFINITY,
  );
  const totals: number[] = [];
  if (Number.isFinite(observations) && observations > 0) {
    for (let i = 0; i < observations; i++) {
      let sum = 0;
      for (const s of STAGES) sum += (samples[s] ?? [])[i] ?? 0;
      totals.push(sum);
    }
  }
  const total = percentiles(totals);

  let bottleneck: LatencyProfile["bottleneck"] = null;
  for (const stage of STAGES) {
    const p = stages[stage];
    if (!p) continue;
    if (!bottleneck || p.p50 > bottleneck.p50Ms) {
      bottleneck = { stage, p50Ms: p.p50, shareOfTotal: 0 };
    }
  }
  if (bottleneck && total && total.p50 > 0) {
    bottleneck.shareOfTotal = bottleneck.p50Ms / total.p50;
  }
  return { stages, total, bottleneck, complete };
}

/**
 * The latency a paper fill should use.
 *
 * `measured` wins. When there is no measurement the caller gets the fallback
 * AND `measured: false`, so a run can record that its fills used a guess rather
 * than silently presenting one as fact.
 */
export type FillLatency = { p50: number; p90: number; p99: number; measured: boolean };

export function fillLatency(
  profile: LatencyProfile | null,
  fallback: { minMs: number; maxMs: number },
): FillLatency {
  if (profile?.total) {
    return { p50: profile.total.p50, p90: profile.total.p90, p99: profile.total.p99, measured: true };
  }
  const mid = (fallback.minMs + fallback.maxMs) / 2;
  return { p50: mid, p90: fallback.maxMs, p99: fallback.maxMs, measured: false };
}

/**
 * Draw one fill delay from a measured distribution.
 *
 * Piecewise over the measured percentiles rather than uniform over a range: a
 * real latency distribution is right-skewed, and a uniform draw under-samples
 * exactly the slow fills that cost the most money.
 */
export function sampleFillLatencyMs(latency: FillLatency, u: number): number {
  const r = Math.min(1, Math.max(0, u));
  // Whole milliseconds: this value becomes a setTimeout, and a fractional ms is
  // both unachievable and a source of float drift at the segment boundaries.
  const lerp = (a: number, b: number, t: number) => Math.round(a + t * (b - a));
  if (r < 0.5) return Math.round(latency.p50);
  if (r < 0.9) return lerp(latency.p50, latency.p90, (r - 0.5) / 0.4);
  return lerp(latency.p90, latency.p99, (r - 0.9) / 0.1);
}
