/**
 * Demo⇄Real mode authority — two-phase commit core (PURE, testable).
 *
 * Invariant: **UI is advisory; the worker is authoritative.** The UI submits a
 * mode *request*; the worker validates it and *activates* the mode, publishing a
 * signed `mode_active`. This module is that validation core:
 *   - Demo→Real requires a type-to-confirm phrase + unlocked wallet + configured caps.
 *   - Real→Demo is always accepted (the safe direction).
 *   - Stale requests (too old) and replays (already-processed id) are rejected.
 *
 * Pure so the safety logic is deterministically testable; the API route + worker
 * loop + UI banner wire to it at the live-trading phase.
 */

export type TradeRuntimeMode = "demo" | "real";

export type ModeRequest = {
  requestId: string;
  mode: TradeRuntimeMode;
  /** Echoed confirmation phrase (required for demo→real). */
  confirmPhrase?: string;
  createdAtMs: number;
};

export type ModeAuthorityContext = {
  currentActive: TradeRuntimeMode;
  walletUnlocked: boolean;
  capsConfigured: boolean;
  /** Required literal phrase for demo→real (e.g. "I_UNDERSTAND_REAL_MONEY"). */
  requiredConfirm: string;
  walletId: string;
  sessionId: string;
  nowMs: number;
  /** Max request age before it's considered stale. */
  maxAgeMs?: number;
  /** Last processed requestId (replay guard). */
  lastRequestId?: string;
};

export type ModeDecision = {
  accept: boolean;
  nextActive: TradeRuntimeMode;
  /** Signed proof of activation (only when transitioning into real). */
  signature: string | null;
  reason: string;
};

const DEFAULT_MAX_AGE_MS = 30_000;

/** Deterministic non-crypto signature for the activation record (djb2). */
export function signModeActivation(parts: { walletId: string; sessionId: string; nowMs: number; mode: TradeRuntimeMode }): string {
  const s = `${parts.mode}:${parts.walletId}:${parts.sessionId}:${parts.nowMs}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `m_${h.toString(16)}_${parts.nowMs}`;
}

export function evaluateModeRequest(req: ModeRequest, ctx: ModeAuthorityContext): ModeDecision {
  const maxAge = ctx.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const keep = (reason: string): ModeDecision => ({
    accept: false,
    nextActive: ctx.currentActive,
    signature: null,
    reason,
  });

  // Replay guard: a requestId we've already acted on is rejected.
  if (ctx.lastRequestId != null && req.requestId === ctx.lastRequestId) {
    return keep("replayed request id");
  }
  // Staleness guard.
  if (ctx.nowMs - req.createdAtMs > maxAge) {
    return keep(`stale request (${ctx.nowMs - req.createdAtMs}ms > ${maxAge}ms)`);
  }
  // No-op (already in the requested mode).
  if (req.mode === ctx.currentActive) {
    return { accept: true, nextActive: ctx.currentActive, signature: null, reason: "already in mode" };
  }

  // Real→Demo is always allowed (safe direction).
  if (req.mode === "demo") {
    return { accept: true, nextActive: "demo", signature: null, reason: "switched to demo" };
  }

  // Demo→Real: gated by confirm phrase + wallet + caps.
  if (req.confirmPhrase !== ctx.requiredConfirm) {
    return keep("confirm phrase mismatch");
  }
  if (!ctx.walletUnlocked) return keep("wallet locked");
  if (!ctx.capsConfigured) return keep("live caps not configured");

  return {
    accept: true,
    nextActive: "real",
    signature: signModeActivation({
      walletId: ctx.walletId,
      sessionId: ctx.sessionId,
      nowMs: ctx.nowMs,
      mode: "real",
    }),
    reason: "activated real (confirmed)",
  };
}
