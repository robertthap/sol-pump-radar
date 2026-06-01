import "server-only";
import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { ENGINE_B_EVAL_SET, EVAL_MINTS_V1 } from "@/lib/continuation/eval-set";
import { resolveMintStage } from "@/lib/continuation/stages";
import { checkOpsHealthy } from "@/lib/continuation/eval-report";
import { fetchTracesForMint } from "@/lib/continuation/trace-store";

export async function buildMissedWinnerReport(mints?: string[]) {
  const list = mints ?? ENGINE_B_EVAL_SET;
  const ops = await checkOpsHealthy();
  const markets = await fetchDexMarketBatch(list);

  const rows = await Promise.all(
    list.map(async (mint) => {
      const def = EVAL_MINTS_V1.find((m) => m.mint === mint);
      const dex = markets.get(mint);
      const [{ stage, missType, detail }, traces] = await Promise.all([
        resolveMintStage(mint, ops),
        fetchTracesForMint(mint, 5),
      ]);
      return {
        mint,
        symbol: def?.symbol ?? mint.slice(0, 6),
        stage,
        missType,
        detail,
        dexH24: dex?.priceChangeH24 ?? null,
        liqUsd: dex?.liqUsd ?? null,
        lastTraceAction: traces[traces.length - 1]?.outputs.action ?? null,
        gapClass: mapGapClass(missType),
      };
    }),
  );

  return { runAt: Date.now(), opsHealthy: ops, rows };
}

function mapGapClass(missType: string): string {
  if (missType === "OPS_FAILURE") return "ops";
  if (missType === "NONE") return "caught";
  if (missType.startsWith("GATE_")) return "veto";
  if (["NOT_IN_UNIVERSE", "NOT_NORMALIZED", "NO_STATE_TRANSITION", "EVENT_MISSED"].includes(missType)) {
    return "coverage";
  }
  if (["LOW_RANK", "LATE_STAGE_PARABOLIC"].includes(missType)) return "rank_or_late";
  return "coverage";
}
