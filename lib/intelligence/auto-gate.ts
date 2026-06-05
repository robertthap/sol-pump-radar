import "server-only";
import { autoContinuationEnabled, env, getEffectiveSignalMode } from "@/lib/env";
import type {
  EngineIntelligenceOutput,
  IntelligenceInputSnapshot,
  IntelligenceRiskFlags,
  IntelligenceSignal,
} from "@/lib/intelligence/types";
import {
  computeAutoTradeAllowedCore,
  isActionableSignalCore,
  type GateInput,
  type GateOutput,
  type GateRisk,
} from "@/lib/intelligence/auto-gate-core";
import {
  defaultGateConfig,
  resolveGateConfig,
  type AutoGateConfig,
  type GateOverrides,
  type SignalMode,
} from "@/lib/intelligence/gate-config";
import { readActiveOverrides } from "@/lib/db/repos/tuner";
import { logger } from "@/lib/log";

const log = logger("auto-gate");

/** Current signal mode — runtime override (UI-selectable) falling back to env. */
export function currentSignalMode(): SignalMode {
  return getEffectiveSignalMode() as SignalMode;
}

export function computeAutoTradeAllowed(
  output: EngineIntelligenceOutput,
  input: IntelligenceInputSnapshot,
  risk: IntelligenceRiskFlags = {},
  config?: AutoGateConfig,
): boolean {
  if (
    output.engine === "B" &&
    output.signal === "CONTINUATION_BUY" &&
    !autoContinuationEnabled()
  ) {
    return false;
  }
  return computeAutoTradeAllowedCore(
    output as GateOutput,
    input as GateInput,
    risk as GateRisk,
    config ?? defaultGateConfig(currentSignalMode()),
  );
}

let gateConfigCache: { at: number; mode: SignalMode; cfg: AutoGateConfig } | null = null;
const GATE_CONFIG_TTL_MS = 30_000;

/**
 * Effective auto-trade gate config = per-mode preset defaults merged with the
 * learner's active overrides (clamped). Cached briefly so the per-tick commit
 * loop pays at most one DB read per {@link GATE_CONFIG_TTL_MS}. This closes the
 * learning loop: outcomes → tuner overrides → the gate that decides buys.
 */
export async function readEffectiveAutoGateConfig(): Promise<AutoGateConfig> {
  const mode = currentSignalMode();
  if (gateConfigCache && gateConfigCache.mode === mode && Date.now() - gateConfigCache.at < GATE_CONFIG_TTL_MS) {
    return gateConfigCache.cfg;
  }
  let overrides: GateOverrides = {};
  try {
    const o = await readActiveOverrides();
    overrides = {
      liqFloorBaseUsd: o.liqFloorBaseUsd,
      engineALiqFloorUsd: o.engineALiqFloorUsd,
      engineARankFloor: o.engineARankFloor,
      engineAVelocityFloor: o.engineAVelocityFloor,
      engineBRankFloor: o.engineBRankFloor,
    };
  } catch (e) {
    // DB not ready / transient — fall back to preset defaults.
    log.debug("readActiveOverrides failed; using preset gate config", { err: String(e) });
  }
  const cfg = resolveGateConfig(mode, overrides);
  gateConfigCache = { at: Date.now(), mode, cfg };
  return cfg;
}

export function isActionableSignal(signal: IntelligenceSignal): boolean {
  return isActionableSignalCore(signal);
}
