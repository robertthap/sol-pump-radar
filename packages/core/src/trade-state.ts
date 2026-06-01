export type TradeFsmState = "INTENT" | "OPEN" | "CLOSING" | "CLOSED" | "FAILED";

const allowed: Record<TradeFsmState, TradeFsmState[]> = {
  INTENT: ["OPEN", "FAILED"],
  OPEN: ["CLOSING", "FAILED"],
  CLOSING: ["CLOSED", "FAILED"],
  CLOSED: [],
  FAILED: [],
};

export function assertTransition(from: TradeFsmState, to: TradeFsmState) {
  if (!allowed[from]?.includes(to)) {
    throw new Error(`Invalid trade FSM transition ${from} -> ${to}`);
  }
}
