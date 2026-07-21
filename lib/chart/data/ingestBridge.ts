import "server-only";

import type { ParsedPumpEvent, ParsedTradeEvent } from "@/lib/pump/parser";
import { ingestChartEvent, getChartPipeline } from "@/lib/chart/runtime/chartRuntime";
import { getChartSubscribedMints } from "@/lib/chart/runtime/chartWsServer";
import { fetchTradesBySignatures } from "@/lib/chart/data/tradeStore";

/** Push path: stage trades for WS-subscribed mints right after ingest flush. */
export async function ingestChartEventsFromBatch(batch: ParsedPumpEvent[]): Promise<void> {
  if (process.env.WORKERS !== "on") return;

  const trades = batch.filter((e): e is ParsedTradeEvent => e.kind === "buy" || e.kind === "sell");
  if (!trades.length) return;

  const subscribed = new Set(getChartSubscribedMints());
  const relevant = trades.filter((t) => subscribed.has(t.mint));
  if (!relevant.length) return;

  const bySig = await fetchTradesBySignatures(relevant.map((t) => t.signature));
  const touched = new Set<string>();
  for (const t of relevant) {
    const raw = bySig.get(t.signature);
    if (!raw) continue;
    touched.add(raw.token);
    await ingestChartEvent(raw.token, raw);
  }
  const pipe = getChartPipeline();
  for (const mint of touched) pipe.flush(mint);
}
