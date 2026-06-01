import { z } from "zod";

export const Solana58 = z
  .string()
  .min(32)
  .max(64)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export const Signature58 = z
  .string()
  .min(64)
  .max(96)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export const TraderMode = z.enum(["paper", "devnet", "live"]);
export type TraderMode = z.infer<typeof TraderMode>;

export const CbState = z.enum(["RUNNING", "DEGRADED", "PAUSED", "HALTED"]);
export type CbState = z.infer<typeof CbState>;

export const RiskPreset = z.enum([
  "conservative",
  "balanced",
  "aggressive",
  // Curve/fee-aware presets (L4): profit_seek = wider TP to clear ~2% round-trip
  // friction on the non-linear bonding curve; launch_snipe = fast newborn scalps.
  "profit_seek",
  "launch_snipe",
]);
export type RiskPreset = z.infer<typeof RiskPreset>;

export const EventKind = z.enum(["create", "buy", "sell", "migrate", "transfer", "set_authority"]);
export type EventKind = z.infer<typeof EventKind>;

export const ModuleId = z.enum([
  "M1_GRADUATION",
  "M2_OFI",
  "M3_RUG",
  "M4_WASH",
  "M5_CLUSTER",
  "M6_CREATOR",
  "M7_HOLDERS",
  "M8_MOMENTUM",
]);
export type ModuleId = z.infer<typeof ModuleId>;

export const DecisionAction = z.enum([
  "BUY_STRONG",
  "BUY_MODERATE",
  "WATCH",
  "SELL_NOW",
  "SELL_TP",
  "AVOID",
]);
export type DecisionAction = z.infer<typeof DecisionAction>;
