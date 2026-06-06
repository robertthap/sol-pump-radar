/**
 * Single canonical automation runtime.
 * Boots Postgres, reconciles paper portfolio, starts orchestrator + paper lanes.
 *
 * Run from repo root:
 *   pnpm worker
 */
import { bootDb } from "@/lib/db/client";
import { startWorkers, stopWorkers } from "@/lib/workers/orchestrator";
import { bootPaperEngine } from "@/lib/paper/engine";
import { startPaperMarkToMarket } from "@/lib/paper/mtm-lane";
import { startPaperResetListener } from "@/lib/paper/reset-listener";
import { startLiveExecutionListener } from "@/lib/workers/live-execution-listener";
import { startPaperTradeListener } from "@/lib/workers/paper-trade-listener";
import { startDemoResetListener } from "@/lib/workers/demo-reset-listener";
import { startWebCommandListener } from "@/lib/workers/web-command-listener";
import { startPhantomLiveListener } from "@/lib/workers/phantom-live-listener";
import { startRuntimeSnapshotWriter } from "@/lib/runtime/runtime-snapshot";
import { startChartWsServer } from "@/lib/chart/runtime/chartWsServer";
import { startChartAggregatorLane } from "@/lib/workers/chart-aggregator-lane";
import { startChartDexQuoteLane } from "@/lib/workers/chart-dex-quote-lane";
import { startChartReconcileLane } from "@/lib/workers/chart-reconcile-lane";
import { startChartGraduationLane } from "@/lib/workers/chart-graduation-lane";
import { bootWorkerWallet } from "@/lib/wallet/worker-vault";
import { acquireWorkerSingleton, releaseWorkerSingleton } from "@/lib/runtime/worker-lock";
import { readState } from "@/lib/circuit-breaker/state";
import { env, logLiveMaxPerTradeAtBoot, logRuntimePresetKeys } from "@/lib/env";

process.env.WORKERS = "on";

const stops: Array<() => void | Promise<void>> = [];

async function main() {
  console.log("[worker] booting Postgres…");
  await bootDb();

  try {
    const { summarizeReplayTail } = await import("@spr/core");
    const tail = await summarizeReplayTail(50);
    if (tail.toId) {
      console.log(
        `[worker] domain_events tail (50): types=${JSON.stringify(tail.byType)} ids=${tail.fromId}..${tail.toId}`,
      );
    }
  } catch {
    /* optional boot diagnostic */
  }

  // Fail fast on bad env (live-without-confirmation, etc).
  logRuntimePresetKeys();
  const e = env();
  logLiveMaxPerTradeAtBoot();
  if (e.SHADOW_LEARNER === "on") {
    console.log(
      `[worker] SHADOW_LEARNER=on — paperOpen/paperClose via @spr/trading (${e.SHADOW_LEARN_SIZE_SOL} SOL/trade)`,
    );
  }
  console.log(
    `[worker] runtime profile: ${e.RUNTIME_PROFILE} | live_execution=${e.LIVE_EXECUTION} | live_dry_run=${e.LIVE_DRY_RUN}`,
  );
  const cb = await readState();
  if (cb.state === "HALTED") {
    console.error(
      `[worker] CIRCUIT BREAKER HALTED — live execution blocked until manual resume. Reason: ${cb.reason}`,
    );
  }

  console.log("[worker] acquiring singleton lock…");
  await acquireWorkerSingleton();
  stops.push(releaseWorkerSingleton);

  console.log("[worker] reconciling paper portfolio…");
  await bootPaperEngine();

  console.log("[worker] booting wallet…");
  const wallet = await bootWorkerWallet();
  if (wallet.unlocked) {
    console.log(`[worker] wallet unlocked: ${wallet.publicKey}`);
  } else if (wallet.publicKey) {
    console.log(
      `[worker] wallet LOCKED (publicKey ${wallet.publicKey}) — live trade intents will reject. ` +
        `Set VAULT_PASSPHRASE to enable.`,
    );
  } else {
    console.log("[worker] no vault — live trade intents will reject");
  }

  console.log("[worker] starting orchestrator…");
  await startWorkers();
  stops.push(stopWorkers);

  console.log("[worker] starting paper mark-to-market…");
  stops.push(startPaperMarkToMarket());

  console.log("[worker] starting paper reset listener…");
  stops.push(startPaperResetListener());

  console.log("[worker] starting live execution listener…");
  stops.push(startLiveExecutionListener());

  console.log("[worker] starting paper trade listener…");
  stops.push(startPaperTradeListener());

  console.log("[worker] starting demo reset listener…");
  stops.push(startDemoResetListener());

  console.log("[worker] starting web command listener…");
  stops.push(startWebCommandListener());

  console.log("[worker] starting phantom live listener…");
  stops.push(startPhantomLiveListener());

  console.log("[worker] starting runtime snapshot writer…");
  stops.push(startRuntimeSnapshotWriter());

  console.log("[worker] starting chart ws + lanes…");
  stops.push(startChartWsServer());
  stops.push(startChartAggregatorLane());
  stops.push(startChartDexQuoteLane());
  stops.push(startChartReconcileLane());
  stops.push(startChartGraduationLane());

  console.log("[worker] running — Ctrl+C to stop");

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} — stopping…`);
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch (e) {
        console.warn("[worker] stop handler failed", e);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
