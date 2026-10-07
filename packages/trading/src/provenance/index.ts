/**
 * Trade provenance and measurement integrity (M06, M07) — PURE, no IO.
 *
 * Nothing recorded WHICH code and WHICH settings produced a trade. A paper run
 * is only evidence if you can say what was running during it, and across a
 * multi-day measurement the config does change — a limit gets raised, a fee
 * constant is corrected, a gate is added. Without provenance on each row, a
 * result is an average over an unknown mixture of configurations, and no amount
 * of later analysis can separate them.
 *
 * The hash covers only settings that can CHANGE A TRADE'S OUTCOME. Adding a
 * cosmetic field must not invalidate a run's comparability, and changing a fee
 * must.
 */

/** The settings whose values can change what a trade does or what it books. */
export type OutcomeAffectingConfig = {
  feeBps: number;
  baseTxFeeSol: number;
  priorityFeeSol: number;
  baseSlippageBps: number;
  enableFees: boolean;
  enableSlippage: boolean;
  enableLatency: boolean;
  latencyMinMs: number;
  latencyMaxMs: number;
  maxPositionSol: number;
  maxOpenPositions: number;
  dailyLossLimitSol: number;
  maxDrawdownPct: number;
  maxDataStalenessMs: number;
  maxPerMintSol: number;
  /** M05 — whether fills used a MEASURED latency distribution or the guess. */
  measuredLatency: { p50: number; p90: number; p99: number } | null;
};

/** The keys, in a FIXED order, so the hash cannot change with object literal order. */
const HASHED_KEYS: Array<keyof OutcomeAffectingConfig> = [
  "feeBps", "baseTxFeeSol", "priorityFeeSol", "baseSlippageBps",
  "enableFees", "enableSlippage", "enableLatency", "latencyMinMs", "latencyMaxMs",
  "maxPositionSol", "maxOpenPositions", "dailyLossLimitSol",
  "maxDrawdownPct", "maxDataStalenessMs", "maxPerMintSol",
  "measuredLatency",
];

/** Canonical text for a config: stable across key order and object identity. */
export function canonicalConfig(config: OutcomeAffectingConfig): string {
  return HASHED_KEYS.map((k) => {
    const v = config[k];
    // measuredLatency is an object; name its values so a change to the measured
    // distribution changes the hash, as it changes every fill.
    if (k === "measuredLatency") {
      const m = v as OutcomeAffectingConfig["measuredLatency"];
      return `measuredLatency=${m ? `${m.p50}/${m.p90}/${m.p99}` : "none"}`;
    }
    return `${k}=${String(v)}`;
  }).join("|");
}

/**
 * FNV-1a over the canonical text, as 8 hex characters.
 *
 * Not cryptographic and not meant to be: this labels runs so they can be
 * grouped and compared, and it must be computable without pulling node:crypto
 * into a module the executor imports.
 */
export function configHash(config: OutcomeAffectingConfig): string {
  const text = canonicalConfig(config);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Adaptive components that must be OFF while measuring (M06).
 *
 * A learner that retunes mid-run makes the run unmeasurable: early trades and
 * late trades came from different strategies, and the average describes neither.
 */
export type AdaptiveSwitches = {
  autoTune: string | undefined;
  shadowLearner: string | undefined;
  autoContinuation: string | undefined;
};

export type MeasurementIntegrity = {
  clean: boolean;
  /** Names of anything still adaptive, for the operator to turn off. */
  active: string[];
};

export function measurementIntegrity(switches: AdaptiveSwitches): MeasurementIntegrity {
  const active: string[] = [];
  // Anything that is not explicitly "off" counts as on: an unset or misspelled
  // value must not read as disabled.
  if (switches.autoTune !== "off") active.push("AUTO_TUNE");
  if (switches.shadowLearner !== "off") active.push("SHADOW_LEARNER");
  if (switches.autoContinuation !== "off") active.push("AUTO_CONTINUATION");
  return { clean: active.length === 0, active };
}

export type TradeProvenance = {
  /** Commit the worker was running, or "unknown" when not supplied at build. */
  codeVersion: string;
  configHash: string;
  /** False when an adaptive component was running — the trade is not measurement-grade. */
  measurementClean: boolean;
  adaptiveActive: string[];
  /** M05 — false means these fills used the 80-280ms guess, not a measurement. */
  latencyMeasured: boolean;
};

export function tradeProvenance(input: {
  codeVersion: string | undefined;
  config: OutcomeAffectingConfig;
  switches: AdaptiveSwitches;
}): TradeProvenance {
  const integrity = measurementIntegrity(input.switches);
  return {
    codeVersion: input.codeVersion?.trim() || "unknown",
    configHash: configHash(input.config),
    measurementClean: integrity.clean,
    adaptiveActive: integrity.active,
    latencyMeasured: input.config.measuredLatency != null,
  };
}
