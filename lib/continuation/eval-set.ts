import "server-only";
import type { EvalMintDefinition, EvalSetSnapshot } from "@/lib/continuation/types";

export const EVAL_MINTS_V1: EvalMintDefinition[] = [
  { mint: "5gdkymiHDBetTnCBjr1YAeqMCeGJKVFRkumrAAgmpump", symbol: "GENWEALTH", expected: "ALERT" },
  { mint: "8Zrbh9DJFgY5H6jqZb3CWeMF6wLGMHiDKvkK4qSTpump", symbol: "CAP", expected: "ALERT" },
  { mint: "5s7tf6ih2CEZf7ZPNkJAtcknAq9DL5GsWHMMT3Jdpump", symbol: "Stake", expected: "ALERT" },
  { mint: "2MBq3mrKSKf6NnG5x29rBK4B9f7CWR4N1EQJ18NsViRL", symbol: "TRALALERO", expected: "ALERT" },
  { mint: "Ac8EScJ4ufRo8PiFkun7diUrcCCktg4JvArb3mPmpump", symbol: "PP420", expected: "ALERT" },
  { mint: "Br1JxELQYP34YdRW4gbEPLasHEtyz8eCmT2FvmnYpump", symbol: "PARALOOM", expected: "ALERT" },
  { mint: "Cjo46uRW2yeF2uXLn2phrVZZyZ1sfnrMNutfrhZopump", symbol: "ETB", expected: "ALERT" },
  { mint: "cig9AXeEzQMUts9WXzmb8S5DapSVJ2b8JnrRmnWRdYz", symbol: "CIG", expected: "ALERT" },
];

export function buildEvalSetSnapshot(
  metrics?: Map<string, { h24: number; liqUsd: number }>,
): EvalSetSnapshot {
  const marketSnapshotAt = Date.now();
  const day = new Date(marketSnapshotAt).toISOString().slice(0, 10);
  return {
    version: `eval-v1-${day}`,
    marketSnapshotAt,
    expectationPolicy: "forensic_j3",
    mints: EVAL_MINTS_V1.map((m) => ({
      ...m,
      dexMetricsAtSnapshot: metrics?.get(m.mint),
    })),
  };
}

export const ENGINE_B_EVAL_SET = EVAL_MINTS_V1.map((m) => m.mint);
