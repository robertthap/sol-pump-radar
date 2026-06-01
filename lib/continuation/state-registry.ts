import "server-only";
import type { MomentumState } from "@/lib/continuation/types";

export type MintStateSnapshot = {
  state: MomentumState;
  rankPercentile: number;
  updatedAt: number;
};

const registry = new Map<string, MintStateSnapshot>();

export function getPriorState(mint: string): MomentumState {
  return registry.get(mint)?.state ?? "cold";
}

export function getPriorRank(mint: string): number | null {
  return registry.get(mint)?.rankPercentile ?? null;
}

export function updateMintStateRegistry(
  mint: string,
  state: MomentumState,
  rankPercentile: number,
  now = Date.now(),
): MintStateSnapshot {
  const row: MintStateSnapshot = { state, rankPercentile, updatedAt: now };
  registry.set(mint, row);
  return row;
}

export function clearStateRegistry() {
  registry.clear();
}
