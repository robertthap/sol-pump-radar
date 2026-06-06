import "server-only";

import { logger } from "@/lib/log";
import { detectGraduation } from "@/lib/chart/data/graduation";
import { fetchStreamState, upsertStreamState } from "@/lib/chart/data/tradeStore";
import { getChartPipeline, touchChartMint } from "@/lib/chart/runtime/chartRuntime";
import { getChartSubscribedMints, broadcastChart } from "@/lib/chart/runtime/chartWsServer";
import { envelope } from "@/lib/chart/realtime/eventRouter";
import type { RegimeSwitchPayload } from "@/lib/chart/types";

const log = logger("chart-graduation");

export function startChartGraduationLane(): () => void {
  const tick = async () => {
    try {
      const mints = getChartSubscribedMints();
      for (const mint of mints) {
        await touchChartMint(mint);
        const stream = await fetchStreamState(mint);
        if (stream?.regime === "dex" && stream.graduationAt) continue;
        const grad = await detectGraduation(mint);
        if (!grad?.graduationAt) continue;

        const pipe = getChartPipeline();
        const st = pipe.getStreamState(mint);
        if (st.regime === "dex" && st.graduationAt) continue;

        st.regime = "dex";
        st.graduationAt = grad.graduationAt;
        pipe.setStreamState(mint, st);

        await upsertStreamState({
          mint,
          epoch: st.epoch,
          lastTradeId: st.lastTradeId,
          lastSeq: st.lastSeq,
          graduationAt: grad.graduationAt,
          regime: "dex",
        });

        const payload: RegimeSwitchPayload = {
          mint,
          from: "bonding_curve",
          to: "dex",
          atTradeId: st.lastTradeId.toString(),
          effectivePrice: 0,
          graduationAt: grad.graduationAt.getTime(),
        };
        broadcastChart(
          mint,
          envelope("REGIME_SWITCH", {
            mint,
            epoch: st.epoch,
            seq: st.lastSeq,
            lastTradeId: st.lastTradeId.toString(),
          }, payload),
        );
      }
    } catch (e) {
      log.warn("graduation tick failed", { err: String(e) });
    }
  };

  const id = setInterval(() => void tick(), 60_000);
  return () => clearInterval(id);
}
