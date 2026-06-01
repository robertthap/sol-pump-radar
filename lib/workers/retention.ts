import "server-only";
import { logger } from "@/lib/log";
import { runRetentionPrune } from "@/lib/db/retention";
import { touchWorker } from "@/lib/workers/heartbeat";

const log = logger("retention");
const TICK_MS = 60 * 60 * 1000;

export async function startRetentionWorker() {
  log.info("retention starting", { tickMs: TICK_MS, interval: "hourly" });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    try {
      await runRetentionPrune();
      touchWorker("retention", { tickMs: Date.now() - t0 });
    } catch (e) {
      log.warn("retention tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return async () => clearInterval(id);
}
