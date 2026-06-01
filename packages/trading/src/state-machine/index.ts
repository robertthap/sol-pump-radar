/**
 * Position lifecycle state machine. Identical to @spr/core/trade-state but
 * applied to paper_positions and live positions. Single source of legal
 * transitions across paper + live transports.
 */

export type PositionState = "INTENT" | "OPEN" | "CLOSING" | "CLOSED" | "FAILED";

const allowed: Record<PositionState, readonly PositionState[]> = {
  INTENT: ["OPEN", "FAILED"],
  OPEN: ["CLOSING", "FAILED"],
  CLOSING: ["CLOSED", "FAILED"],
  CLOSED: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: PositionState, to: PositionState) {
    super(`invalid position transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: PositionState, to: PositionState): void {
  if (!allowed[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function isTerminal(state: PositionState): boolean {
  return state === "CLOSED" || state === "FAILED";
}
