import "server-only";

import { logger } from "@/lib/log";
import { touchWorker } from "@/lib/workers/heartbeat";
import { refreshDexSnapshots } from "@/lib/chart/runtime/chartWsServer";

const log = logger("chart-gecko-refresh");

// Graduated DEX charts refresh from GeckoTerminal OHLCV. The fetch is cached
// (~20 s per resolution) so this cadence keeps live charts current without
// exceeding the free-tier rate limit.
const REFRESH_MS = 20_000;

export function startChartGeckoRefreshLane(): () => void {
  const tick = async () => {
    const t0 = Date.now();
    try {
      await refreshDexSnapshots();
    } catch (e) {
      log.warn("gecko refresh tick failed", { err: String(e) });
    } finally {
      touchWorker("chart-gecko-refresh", { tickMs: Date.now() - t0 });
    }
  };

  const id = setInterval(() => void tick(), REFRESH_MS);
  return () => clearInterval(id);
}
