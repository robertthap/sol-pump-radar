import "server-only";
import type { DecisionAction } from "@/lib/shared/types";
import type { ScoredMint } from "@/lib/workers/analytics";
import type { MintFlags } from "@/lib/db/repos/bots";
import {
  buildCrossMintRanks,
  evaluateMintIntelligence,
} from "@/lib/intelligence/dual-engine";
import type {
  EngineIntelligenceOutput,
  IntelligenceSignal,
} from "@/lib/intelligence/types";
import {
  rankInputFromScoredMint,
  riskFlagsFromScored,
  scoredMintToIntelligenceInput,
} from "@/lib/intelligence/scored-mint-adapter";

export function intelligenceSignalToDecisionAction(
  signal: IntelligenceSignal,
): DecisionAction | null {
  switch (signal) {
    case "BUY_STRONG":
      return "BUY_STRONG";
    case "BUY_MODERATE":
      return "BUY_MODERATE";
    case "WATCH":
      return "WATCH";
    case "AVOID":
      return "AVOID";
    default:
      return null;
  }
}

export type EngineADecisionBridge = {
  action: DecisionAction | null;
  reason: string;
  intelligence: EngineIntelligenceOutput;
};

/** Engine A path for launch-mode decision worker (strict contract). */
export function decideEngineAForUniverse(
  scored: ScoredMint[],
  opts?: {
    flagsByMint?: Map<string, MintFlags>;
    rugsByMint?: Map<string, string>;
    priorRanks?: Map<string, number>;
  },
): Map<string, EngineADecisionBridge> {
  const rankRows = scored.map(rankInputFromScoredMint);
  const crossTable = buildCrossMintRanks(rankRows, opts?.priorRanks ?? new Map(), 0.17);
  const out = new Map<string, EngineADecisionBridge>();

  for (const s of scored) {
    const input = scoredMintToIntelligenceInput(s);
    const cross = crossTable.get(s.mint) ?? {
      rank_percentile: 0.5,
      velocity_rank: 0.5,
      liquidity_rank: 0.5,
    };
    const intelligence = evaluateMintIntelligence(input, {
      engine: "A",
      cross_mint: cross,
      risk_flags: riskFlagsFromScored(
        s,
        opts?.flagsByMint?.get(s.mint),
        opts?.rugsByMint?.get(s.mint),
      ),
      in_universe: true,
      normalized: true,
      ops_healthy: true,
      universe_size: scored.length,
    });

    const action = intelligenceSignalToDecisionAction(intelligence.signal);
    const autoNote = intelligence.auto_trade_allowed ? "|auto_ok" : "|auto_blocked";
    out.set(s.mint, {
      action,
      reason: `${intelligence.reason}${autoNote}`,
      intelligence,
    });
  }

  return out;
}

export function decideEngineAForScoredMint(
  s: ScoredMint,
  scored: ScoredMint[],
  opts?: {
    flags?: MintFlags | null;
    rugLabel?: string;
    priorRanks?: Map<string, number>;
  },
): EngineADecisionBridge {
  return (
    decideEngineAForUniverse(scored, {
      flagsByMint: opts?.flags ? new Map([[s.mint, opts.flags]]) : undefined,
      rugsByMint: opts?.rugLabel ? new Map([[s.mint, opts.rugLabel]]) : undefined,
      priorRanks: opts?.priorRanks,
    }).get(s.mint) ?? {
      action: null,
      reason: "engine=A|no_output",
      intelligence: evaluateMintIntelligence(scoredMintToIntelligenceInput(s), { engine: "A" }),
    }
  );
}
