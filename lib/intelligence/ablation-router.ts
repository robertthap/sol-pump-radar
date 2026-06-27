/**
 * T4.1 — Subtractive-ablation router (pure, no IO).
 *
 * One switch, six+ configurations — NOT six code forks (forks introduce
 * different bugs masquerading as strategy differences). Given a variant and a
 * snapshot's score vector, decide enter/skip. The variant ladder adds exactly
 * one subsystem per rung so its marginal contribution is isolable:
 *
 *   V0  null baseline   — random entry (the true floor)
 *   V1  minimal         — V0-gate replaced by the core intelligence score only
 *   V2  + M3 rug veto   — defense before offense
 *   V3  + M1/M2/M4/M5   — the rest of the analytics modules
 *   V4  + confluence    — the maturity/graduation floor (three-gate proxy)
 *   V5  + Engine A      — launch-signal inclusion
 *   V6  full system     — the live `_auto_trade_allowed` decision
 *
 * The interesting numbers are the DELTAS between adjacent rungs (V3−V2 = the
 * marginal value of M1/M2/M4/M5, etc.). If V6 ≈ V1 within CI, the apparatus
 * between them is cost without benefit.
 *
 * Operates on the score vector recorded in feature_snapshots.features.module_scores
 * — so the ablation runs OFFLINE over the same recorded population for every
 * variant (no time confound).
 */

export type AblationVariant = "V0" | "V1" | "V2" | "V3" | "V4" | "V5" | "V6";

/** The score vector the router gates on (extracted from a snapshot). */
export type AblationFeatures = {
  intelligence: number;   // module_scores._intelligence  [0,1]
  rug: number;            // module_scores.M3_RUG          [0,1]
  insider: number;        // module_scores.M2_INSIDER      [0,1]
  wash: number;           // module_scores.M5_WASH         [0,1]
  creator: number;        // module_scores.M4_CREATOR      [0,1]
  grad: number;           // module_scores.M1_GRADUATION   [0,1]
  engineA: number;        // module_scores._engine_a       (0/1+)
  autoAllowed: number;    // module_scores._auto_trade_allowed (0/1)
};

/**
 * Thresholds — chosen to mirror the live gates (entry-filter / module vetoes)
 * so the ladder reconstructs the real decision stack:
 *   - M3 rug hard veto at 0.70 (lib/trade/entry-filter passesModuleVetoes)
 *   - M2 insider concentration veto at 0.58
 *   - M5 wash veto at 0.65
 *   - M4 creator risk gate at 0.65
 *   - intelligence floor at 0.50 (above-median signal)
 *   - graduation/confluence floor at 0.35
 */
export const ABLATION_THRESHOLDS = {
  intelFloor: 0.5,
  rugVeto: 0.7,
  insiderVeto: 0.58,
  washVeto: 0.65,
  creatorVeto: 0.65,
  gradFloor: 0.35,
} as const;

const T = ABLATION_THRESHOLDS;

/**
 * Deterministic per-snapshot pseudo-random in [0,1) from the snapshot id, so V0
 * is reproducible across runs (same snapshots → same random picks). FNV-1a hash.
 */
export function seededUnit(snapshotId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < snapshotId.length; i++) {
    h ^= snapshotId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** V0 random entry rate — tuned to roughly match V6's admit rate so the floor
 *  has a comparable trade count for the bootstrap. */
export const V0_RANDOM_RATE = 0.25;

/**
 * Does this variant enter on this snapshot? `snapshotId` is only used by V0
 * (deterministic random). Returns true = would open a position.
 */
export function variantEnters(
  variant: AblationVariant,
  f: AblationFeatures,
  snapshotId: string,
): boolean {
  switch (variant) {
    case "V0":
      return seededUnit(snapshotId) < V0_RANDOM_RATE;
    case "V1":
      return f.intelligence >= T.intelFloor;
    case "V2":
      return f.intelligence >= T.intelFloor && f.rug < T.rugVeto;
    case "V3":
      return (
        f.intelligence >= T.intelFloor &&
        f.rug < T.rugVeto &&
        f.insider < T.insiderVeto &&
        f.wash < T.washVeto &&
        f.creator < T.creatorVeto
      );
    case "V4":
      return (
        f.intelligence >= T.intelFloor &&
        f.rug < T.rugVeto &&
        f.insider < T.insiderVeto &&
        f.wash < T.washVeto &&
        f.creator < T.creatorVeto &&
        f.grad >= T.gradFloor
      );
    case "V5":
      // V4 OR an Engine-A launch signal (continuation/launch inclusion).
      return (
        (f.intelligence >= T.intelFloor &&
          f.rug < T.rugVeto &&
          f.insider < T.insiderVeto &&
          f.wash < T.washVeto &&
          f.creator < T.creatorVeto &&
          f.grad >= T.gradFloor) ||
        f.engineA >= 1
      );
    case "V6":
      // The live full-system decision as recorded at snapshot time.
      return f.autoAllowed >= 1;
  }
}

export const ALL_VARIANTS: AblationVariant[] = ["V0", "V1", "V2", "V3", "V4", "V5", "V6"];

/** Adjacent deltas whose CIs answer "did adding this subsystem help?". */
export const ADJACENT_DELTAS: Array<{ from: AblationVariant; to: AblationVariant; isolates: string }> = [
  { from: "V0", to: "V1", isolates: "core intelligence score vs random" },
  { from: "V1", to: "V2", isolates: "M3 rug veto" },
  { from: "V2", to: "V3", isolates: "M1/M2/M4/M5 modules" },
  { from: "V3", to: "V4", isolates: "graduation/confluence floor" },
  { from: "V4", to: "V5", isolates: "Engine-A launch inclusion" },
  { from: "V5", to: "V6", isolates: "fusion / full system" },
  { from: "V1", to: "V6", isolates: "the entire apparatus above the minimal model" },
];
