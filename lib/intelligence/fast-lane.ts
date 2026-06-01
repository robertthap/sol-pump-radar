/**
 * Fast-lane hot path (PURE core — no server-only, testable). L3.1.
 *
 * The latency fix. The normal path round-trips Postgres (ingest flush 500ms →
 * intelligence-commit 3s tick + 35s skip → auto-trader 3s tick). For a *fresh
 * launch* that's seconds too slow. The fast-lane evaluates a launch in-memory
 * the instant its event arrives and, if it clears a high quality bar, enqueues
 * it for immediate execution — the decision_log write happens asynchronously on
 * the audit path, never in the hot path.
 *
 * Two paths, never conflated:
 *   HOT  : event → shouldFastLaneFire → enqueue → executor (target <100ms)
 *   AUDIT: async batched writes to decision_log / domain_events
 *
 * This module is the pure, tested core (decision + dedup + bounded queue). Wiring
 * it to the live ingestor/executor is gated by env `FAST_LANE=on` (default off)
 * so the verified auto-trader path is untouched until the live latency check runs.
 */
import {
  scoreLaunchVelocity,
  DEFAULT_VELOCITY_CONFIG,
} from "@/lib/intelligence/launch-velocity";
import type { AutoGateConfig } from "@/lib/intelligence/gate-config";

export type FastLaneCandidate = {
  mint: string;
  /** Bonding-curve liquidity (SOL). */
  vSol: number;
  priorVSol?: number;
  uniqueBuyers: number;
  buySellRatio: number;
  priceImpulsePct?: number;
  /** Cross-mint rank percentile if known, else 0.5. */
  rank: number;
  /** Launch state (must be in the gate's allowed states). */
  state: string;
  /** When the launch event arrived — the latency baseline. */
  createdAtMs: number;
  riskFlags?: { rug?: boolean; bundle?: boolean; insider?: boolean };
};

export type FastLaneDecision = {
  fire: boolean;
  velocityScore: number;
  reason: string;
};

/**
 * Pure quality gate for the hot path: risk-clean + allowed state + sufficient
 * launch velocity + rank + a minimum SOL liquidity floor. (The full USD gate
 * still runs later on the audit path.)
 */
export function shouldFastLaneFire(
  c: FastLaneCandidate,
  cfg: AutoGateConfig,
  minVSol: number,
): FastLaneDecision {
  if (c.riskFlags?.rug || c.riskFlags?.bundle || c.riskFlags?.insider) {
    return { fire: false, velocityScore: 0, reason: "risk_flag" };
  }
  if (!cfg.engineA.allowStates.includes(c.state)) {
    return { fire: false, velocityScore: 0, reason: `state=${c.state}` };
  }
  if (c.vSol < minVSol) {
    return { fire: false, velocityScore: 0, reason: `vSol ${c.vSol} < ${minVSol}` };
  }
  const v = scoreLaunchVelocity(
    {
      vSol: c.vSol,
      priorVSol: c.priorVSol,
      uniqueBuyers: c.uniqueBuyers,
      buySellRatio: c.buySellRatio,
      priceImpulsePct: c.priceImpulsePct,
    },
    { ...DEFAULT_VELOCITY_CONFIG, minVSol: Math.max(1, minVSol) },
  );
  if (v.vetoed) return { fire: false, velocityScore: 0, reason: v.vetoReason ?? "veto" };
  if (v.score < cfg.engineA.velocityFloor) {
    return { fire: false, velocityScore: v.score, reason: `velocity ${v.score.toFixed(2)} < ${cfg.engineA.velocityFloor}` };
  }
  if (c.rank < cfg.engineA.rankFloor) {
    return { fire: false, velocityScore: v.score, reason: `rank ${c.rank.toFixed(2)} < ${cfg.engineA.rankFloor}` };
  }
  return { fire: true, velocityScore: v.score, reason: "fast_lane_fire" };
}

export type QueuedOpen = {
  mint: string;
  vSol: number;
  velocityScore: number;
  createdAtMs: number;
  enqueuedAtMs: number;
};

export type OfferResult = "enqueued" | "deduped" | "rejected" | "dropped";

/**
 * Bounded in-memory hot-path queue with per-mint idempotency (one fire per
 * `dedupWindowMs`) and drop-oldest backpressure. Never blocks the WS callback.
 */
export class FastLaneQueue {
  private buffer: QueuedOpen[] = [];
  private lastFireAt = new Map<string, number>();

  constructor(
    private readonly cap = 64,
    private readonly dedupWindowMs = 60_000,
  ) {}

  offer(c: FastLaneCandidate, decision: FastLaneDecision, nowMs: number): OfferResult {
    if (!decision.fire) return "rejected";
    const last = this.lastFireAt.get(c.mint);
    if (last != null && nowMs - last < this.dedupWindowMs) return "deduped";
    this.lastFireAt.set(c.mint, nowMs);
    this.buffer.push({
      mint: c.mint,
      vSol: c.vSol,
      velocityScore: decision.velocityScore,
      createdAtMs: c.createdAtMs,
      enqueuedAtMs: nowMs,
    });
    if (this.buffer.length > this.cap) {
      this.buffer.shift(); // drop oldest under backpressure
      return "dropped";
    }
    return "enqueued";
  }

  /** Remove and return all queued opens (executor consumes these). */
  drain(): QueuedOpen[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  size(): number {
    return this.buffer.length;
  }

  /** Decision→enqueue latency for a queued item (hot-path measurement). */
  static latencyMs(q: QueuedOpen): number {
    return Math.max(0, q.enqueuedAtMs - q.createdAtMs);
  }
}
