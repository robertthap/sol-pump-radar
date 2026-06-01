/** Map miss taxonomy → actionable fix (WHY MISSED panel). */

export function suggestedFixForMiss(missType: string): string {
  switch (missType) {
    case "NOT_IN_UNIVERSE":
      return "Widen continuation-universe discovery or lower profit-mode filters so Dex movers enter commit bundle.";
    case "NOT_NORMALIZED":
      return "Check Dex snapshot cache / API fallback; ensure fetchDexMarketBatch returns a pair for this mint.";
    case "NO_STATE_TRANSITION":
      return "Shorten intelligence-commit skip window or raise event-stream priority so rank jumps land before universe refresh.";
    case "EVENT_MISSED":
      return "Increase continuation-event-stream frequency or hot-mint TTL after volume_spike / rank_jump.";
    case "LOW_RANK":
      return "Token moved but lost rank competition — review cross-mint rank inputs, not entry timing alone.";
    case "LATE_STAGE_PARABOLIC":
    case "LATE_PARABOLIC":
      return "Correctly skipped late chase — no fix unless you accept higher extension risk in auto-gate.";
    case "OPS_FAILURE":
      return "Check `pnpm worker` is running, RPC health, and worker heartbeats on /api/health.";
    case "GATE_BLOCKED":
    case "GATE_BLOCKED_EXHAUSTION":
    case "GATE_BLOCKED_LOW_BREAKOUT":
      return "Auto-trade gate veto — inspect risk flags, liquidity floor, and engine-specific acceleration rules.";
    default:
      return "Inspect decision_trace + JSONL traces for this mint; compare replay vs live commit timing.";
  }
}
