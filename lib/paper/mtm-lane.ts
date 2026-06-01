import "server-only";
import { paperMarkToMarket, getPaperConfig } from "./engine";
import { logger } from "@/lib/log";

const log = logger("paper-mtm");

/**
 * Periodically mark all open paper positions to market and update the
 * portfolio equity row. Bounded by the number of open positions
 * (small; capped via PAPER_MAX_OPEN_POSITIONS).
 */
export function startPaperMarkToMarket(): () => void {
  const config = getPaperConfig();
  const interval = Math.max(2000, config.markToMarketMs);
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await paperMarkToMarket();
      if (out.positions > 0) {
        log.info("mtm", {
          positions: out.positions,
          unrealizedSol: out.totalUnrealized.toFixed(4),
        });
      }
    } catch (e) {
      log.warn("mtm tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  };

  const t = setInterval(() => {
    void tick();
  }, interval);
  // first run a bit after boot so position prices are warm
  setTimeout(() => void tick(), 6_000);

  return () => {
    stopped = true;
    clearInterval(t);
  };
}
