import "server-only";
import { logger } from "@/lib/log";
import { ensureInitialState, readState } from "@/lib/circuit-breaker/state";
import { startIngestor } from "./ingestor";
import { startAnalytics } from "./analytics";
import { startTrader } from "./trader";
import { startLearner } from "./learner";
import { startNotifier } from "./notifier";
import { startAutoTrader } from "./auto-trader";
import { startBotDetector } from "./bot-detector";
import { startClusterer } from "./clusterer";
import { startRugLabeler } from "./rug-labeler";
import { startShadowLearner } from "./shadow-learner";
import { startTrendScanner } from "./trend-scanner";
import { startContinuationUniverse } from "./continuation-universe";
import { startIntelligenceCommit } from "./intelligence-commit";
import { startContinuationEventStream } from "./continuation-event-stream";
import { startMissedWinnerScan } from "./missed-winner-scan";
import { startContinuationLearner } from "./continuation-learner";
import { startRetentionWorker } from "./retention";
import { touchOrchestratorBoot } from "./heartbeat";
import { env } from "@/lib/env";

const log = logger("orchestrator");

declare global {
  // eslint-disable-next-line no-var
  var __spr_workers_started__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __spr_worker_stops__: Array<() => Promise<void> | void> | undefined;
}

export async function startWorkers() {
  // Hard guard: this module is the automation runtime. It must only be invoked
  // from apps/worker. Next.js routes must never reach this code path.
  if (process.env.NEXT_RUNTIME) {
    throw new Error(
      "lib/workers/orchestrator imported from Next.js runtime. " +
        "Workers must boot via `pnpm worker` (apps/worker), not Next instrumentation or API routes.",
    );
  }
  if (globalThis.__spr_workers_started__) return;
  globalThis.__spr_workers_started__ = true;
  globalThis.__spr_worker_stops__ = [];

  const { getSolUsd } = await import("@/lib/market/sol-usd");
  void getSolUsd().catch(() => undefined);
  // Keep SOL/USD fresh — mcap math + gates read it synchronously (getSolUsdSync),
  // so warming only at boot lets the price drift over a long session.
  const solUsdTimer = setInterval(() => void getSolUsd().catch(() => undefined), 60_000);
  globalThis.__spr_worker_stops__.push(() => clearInterval(solUsdTimer));

  // Load the UI-selected SIGNAL_MODE override (launch/hybrid/profit) and keep it
  // fresh, so switching strategy from the frontend takes effect in this worker
  // within seconds — no .env edit or restart. Falls back to the env default.
  const { refreshSignalModeOverride } = await import("@/lib/settings/signal-mode");
  await refreshSignalModeOverride().catch(() => undefined);
  const signalModeTimer = setInterval(
    () => void refreshSignalModeOverride().catch(() => undefined),
    8_000,
  );
  globalThis.__spr_worker_stops__.push(() => clearInterval(signalModeTimer));

  // Fresh-start: clear the persisted UI wallet selection so a (re)started system begins
  // LOGGED OUT — the user picks Demo/Real again on the home page. Pairs with the
  // auto-trader retiring any active session on boot, so nothing trades (and no browse
  // page acts as a logged-in demo) until the user explicitly chooses. Safe default,
  // and important for live. Only an explicit pick (setMode) re-establishes the mode.
  const { clearUiTradingMode } = await import("@/lib/db/repos/trading-mode");
  await clearUiTradingMode().catch(() => undefined);

  await ensureInitialState();
  touchOrchestratorBoot();
  const cb = await readState();
  log.info("workers booting", { cbState: cb.state });

  globalThis.__spr_worker_stops__.push(await startIngestor());
  globalThis.__spr_worker_stops__.push(await startAnalytics());
  if (env().LEGACY_TRADER === "on") {
    globalThis.__spr_worker_stops__.push(await startTrader());
  } else {
    log.info("legacy trader lane disabled (LEGACY_TRADER=off)");
  }
  globalThis.__spr_worker_stops__.push(await startAutoTrader());
  globalThis.__spr_worker_stops__.push(await startBotDetector());
  globalThis.__spr_worker_stops__.push(await startClusterer());
  globalThis.__spr_worker_stops__.push(await startRugLabeler());
  globalThis.__spr_worker_stops__.push(await startShadowLearner());
  globalThis.__spr_worker_stops__.push(await startTrendScanner());
  globalThis.__spr_worker_stops__.push(await startContinuationUniverse());
  globalThis.__spr_worker_stops__.push(await startContinuationEventStream());
  globalThis.__spr_worker_stops__.push(await startIntelligenceCommit());
  globalThis.__spr_worker_stops__.push(await startMissedWinnerScan());
  globalThis.__spr_worker_stops__.push(await startRetentionWorker());
  globalThis.__spr_worker_stops__.push(await startContinuationLearner());
  globalThis.__spr_worker_stops__.push(await startLearner());
  globalThis.__spr_worker_stops__.push(await startNotifier());

  log.info("workers running");
}

export async function stopWorkers() {
  if (!globalThis.__spr_workers_started__) return;
  for (const fn of globalThis.__spr_worker_stops__ ?? []) {
    try {
      await fn();
    } catch (e) {
      log.warn("stop handler failed", { err: String(e) });
    }
  }
  globalThis.__spr_workers_started__ = false;
}
