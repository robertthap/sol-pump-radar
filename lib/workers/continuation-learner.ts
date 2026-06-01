import "server-only";
import { logger } from "@/lib/log";
import { isProfitSignalMode } from "@/lib/env";
import { touchWorker } from "@/lib/workers/heartbeat";

const log = logger("continuation-learner");

/** Stub — proposes threshold tweaks from Engine B paper outcomes; never auto-applies. */
export async function startContinuationLearner() {
  if (!isProfitSignalMode()) return () => undefined;

  log.info("continuation-learner stub active (no auto-apply)");
  touchWorker("continuation-learner");

  return async () => undefined;
}
