/**
 * HALT safety boundary for the auto-trader (no server-only — testable).
 *
 * Two moments matter, and they pull in opposite directions:
 *
 *   ENTRIES — a tick reads the breaker once at the top, then does many external
 *   round-trips (flow, DEX, insiders, pump API) before a fill. A HALT raised in
 *   that window would otherwise still open a position, so `haltedNow` is checked
 *   again immediately before execution.
 *
 *   EXITS — a HALT must NOT abandon positions that are already open. Retiring the
 *   session first left them unmanaged until the next tick's orphan sweep (paper)
 *   or indefinitely (live, which the sweep does not cover), so `runHaltShutdown`
 *   runs one final exit pass BEFORE the session is stopped.
 *
 * Both take their collaborators as arguments rather than importing the breaker
 * and the session, so the real production functions can be exercised in a unit
 * test without the database. `lib/workers/auto-trader.ts` binds them to the real
 * `readState` / `handleExits` / `stopSession`.
 */
import type { CbState } from "@/lib/shared/types";

/** Reads current breaker state. Bound to `lib/circuit-breaker/state.ts` readState. */
export type BreakerRead = () => Promise<{ state: CbState }>;

/**
 * Final pre-execution gate: may a trade be executed at this instant?
 *
 * FAILS CLOSED. If the breaker cannot be read we return `true` (halted) rather
 * than assuming the system is healthy — an unreadable breaker is exactly the
 * condition under which executing is least defensible.
 *
 * Only HALTED blocks. DEGRADED and PAUSED are handled by the tick's own logic;
 * widening this predicate would silently change trading behaviour.
 */
export async function haltedNow(
  read: BreakerRead,
  onReadError?: (err: unknown) => void,
): Promise<boolean> {
  try {
    return (await read()).state === "HALTED";
  } catch (err) {
    onReadError?.(err);
    return true;
  }
}

/**
 * HALT shutdown sequence: manage exits ONE last time, then retire the session.
 *
 * Order is the whole point. A failing exit pass must not block retirement, so
 * the exit error is reported and swallowed — but `stopSession` never runs first.
 */
export async function runHaltShutdown(steps: {
  handleExits: () => Promise<void>;
  stopSession: () => Promise<void>;
  onExitError?: (err: unknown) => void;
}): Promise<void> {
  try {
    await steps.handleExits();
  } catch (err) {
    steps.onExitError?.(err);
  }
  await steps.stopSession();
}
