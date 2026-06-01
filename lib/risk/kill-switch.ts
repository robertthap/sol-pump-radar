/**
 * Portfolio kill-switch decision (PURE — no server-only, testable). L6.1.
 *
 * Bounds downside so the system can't self-destruct in a bad run: halts on a
 * daily-loss cap or a consecutive-loss streak, and honors a cooldown window so
 * a tripped streak pauses new entries (then auto-recovers) rather than churning.
 */

export type KillSwitchInput = {
  /** Magnitude of today's realized loss (SOL, positive). */
  dailyLossSol: number;
  maxDailyLossSol: number;
  /** Current trailing consecutive-loss streak. */
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  /** If set and in the future, entries are paused until this time. */
  cooldownUntilMs?: number;
  nowMs?: number;
};

export type KillSwitchScope = "none" | "cooldown" | "daily_loss" | "consecutive";
export type KillSwitchResult = { halt: boolean; scope: KillSwitchScope; reason: string | null };

export function evaluateKillSwitch(i: KillSwitchInput): KillSwitchResult {
  const now = i.nowMs ?? Date.now();
  if (i.cooldownUntilMs != null && now < i.cooldownUntilMs) {
    return {
      halt: true,
      scope: "cooldown",
      reason: `cooldown ${Math.ceil((i.cooldownUntilMs - now) / 1000)}s remaining`,
    };
  }
  if (i.maxDailyLossSol > 0 && i.dailyLossSol >= i.maxDailyLossSol) {
    return {
      halt: true,
      scope: "daily_loss",
      reason: `daily loss ${i.dailyLossSol.toFixed(3)} ≥ cap ${i.maxDailyLossSol}`,
    };
  }
  if (i.maxConsecutiveLosses > 0 && i.consecutiveLosses >= i.maxConsecutiveLosses) {
    return {
      halt: true,
      scope: "consecutive",
      reason: `${i.consecutiveLosses} consecutive losses ≥ ${i.maxConsecutiveLosses}`,
    };
  }
  return { halt: false, scope: "none", reason: null };
}
