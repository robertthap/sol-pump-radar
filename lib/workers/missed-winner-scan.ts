import "server-only";
import { logger } from "@/lib/log";
import { isProfitSignalMode } from "@/lib/env";
import { runEngineBEval, checkOpsHealthy } from "@/lib/continuation/eval-report";
import { insertDecisionTrace } from "@/lib/db/repos/decision-trace";
import { touchWorker } from "@/lib/workers/heartbeat";

const log = logger("missed-winner-scan");
const TICK_MS = 60 * 60 * 1000;

export async function startMissedWinnerScan() {
  if (!isProfitSignalMode()) return () => undefined;

  async function tick() {
    try {
      const ops = await checkOpsHealthy();
      const report = await runEngineBEval(ops);
      await insertDecisionTrace({
        mint: "SYSTEM",
        stage: "daily_miss_report",
        engine: "B",
        action: "WATCH",
        reason: `eval matched=${report.summary.matched} missed=${report.summary.missed}`,
        featureSnapshot: report,
      });
      log.info("missed-winner scan", report.summary);
      touchWorker("missed-winner-scan");
    } catch (e) {
      log.warn("missed-winner-scan failed", { err: String(e) });
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return async () => clearInterval(id);
}
