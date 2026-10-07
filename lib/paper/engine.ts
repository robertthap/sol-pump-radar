import "server-only";
import { readState } from "@/lib/circuit-breaker/state";
import { env } from "@/lib/env";
import { getIngestorStats } from "@/lib/rpc/stats";
import { feedDegraded } from "@/lib/workers/feed-health";
import {
  paperConfigFromEnv,
  ensurePortfolio,
  loadPortfolio,
  loadOpenPositions,
  openPosition,
  type EntryHealth,
  closePosition,
  partialClosePosition,
  markToMarket,
  resetPortfolio,
  todayRealizedLossSol,
  type PaperRuntimeConfig,
  type ExecutionResult,
  type OpenIntent,
  type CloseIntent,
  type PartialCloseIntent,
  type ResetIntent,
} from "@spr/trading";
import { appendEvent } from "@spr/core";
import { logger } from "@/lib/log";
import { paperPriceResolver } from "./price-resolver";
import {
  researchBuy,
  researchClose,
  researchCloseAtMark,
  researchCensor,
  researchFailureFee,
} from "@spr/trading";

export const paperResearchBuy = (input: Parameters<typeof researchBuy>[0]) => researchBuy(input, getPaperConfig());
export const paperResearchClose = researchClose;
export const paperResearchCloseAtMark = researchCloseAtMark;
export const paperResearchCensor = researchCensor;
export const paperResearchFailureFee = researchFailureFee;

const log = logger("paper-engine");

let cachedConfig: PaperRuntimeConfig | null = null;

export function getPaperConfig(): PaperRuntimeConfig {
  if (!cachedConfig) cachedConfig = paperConfigFromEnv();
  return cachedConfig;
}

/** Worker boot: portfolio reconciliation. DB always wins. */
export async function bootPaperEngine(): Promise<void> {
  const config = getPaperConfig();
  const { portfolio, session, created } = await ensurePortfolio({ startSol: config.startSol });
  const open = await loadOpenPositions(portfolio.sessionId);
  log.info("paper engine boot", {
    created,
    sessionId: portfolio.sessionId.toString(),
    balanceSol: portfolio.balanceSol,
    equitySol: portfolio.equitySol,
    openPositions: open.length,
    config: {
      startSol: config.startSol,
      maxOpenPositions: config.maxOpenPositions,
      maxPositionSol: config.maxPositionSol,
      dailyLossLimitSol: config.dailyLossLimitSol,
    },
  });
  await appendEvent({
    type: "RECONCILE_BOOT",
    payload: {
      scope: "paper",
      portfolio: {
        sessionId: portfolio.sessionId.toString(),
        balanceSol: portfolio.balanceSol,
        equitySol: portfolio.equitySol,
        openPositions: open.length,
        realizedPnlSol: portfolio.realizedPnlSol,
      },
      created,
    },
    sessionId: portfolio.sessionId,
    dedupeKey: `paper:boot:${session.startedAt.toISOString()}`,
  });
}

/**
 * Health of the live feed and the breaker, read HERE rather than asked of every
 * caller (H09).
 *
 * There are five call sites for paperOpen. Requiring each to pass its own view
 * of system health is how one of them ends up not doing it, so this reads the
 * real signals once: the circuit breaker, the ingest connection state, and how
 * long it has been since a message arrived.
 */
async function currentEntryHealth(): Promise<EntryHealth> {
  const [cb, stats] = [await readState(), getIngestorStats()];
  const e = env();
  return {
    breakerState: cb.state as EntryHealth["breakerState"],
    // M07 — set GIT_SHA at build/deploy so every trade names the commit that
    // made it. Absent, it records "unknown" rather than a blank.
    codeVersion: e.GIT_SHA,
    // M06 — the adaptive switches as they stood at decision time, so a trade
    // taken while a learner was running is marked not measurement-grade rather
    // than quietly averaged in with the clean ones.
    adaptiveSwitches: {
      autoTune: e.AUTO_TUNE,
      shadowLearner: e.SHADOW_LEARNER,
      autoContinuation: e.AUTO_CONTINUATION,
    },
    // Never connected means there is no age to report — which checkRisk treats
    // as stale, not as fresh.
    dataAgeMs: stats.lastMessageAt == null ? null : Math.max(0, Date.now() - stats.lastMessageAt),
    // Degraded means the feed is shedding data NOW. Asking the CUMULATIVE
    // eventsDropped counter instead meant one old blip refused every entry for
    // the rest of the process's life — the bot would take a few trades, drop an
    // event, and silently never trade again (H09 regression).
    feedDegraded: feedDegraded(stats, Date.now()),
  };
}

export async function paperOpen(
  intent: OpenIntent,
  /** Override for tests and for callers that genuinely know better. */
  health?: EntryHealth,
): Promise<ExecutionResult<{ positionId: bigint; fillPrice: number; slippageBps: number; latencyMs: number; feeSol: number }>> {
  return openPosition(
    intent, getPaperConfig(), paperPriceResolver, health ?? (await currentEntryHealth()),
  );
}

export async function paperClose(
  intent: CloseIntent,
): Promise<ExecutionResult<{ exitPrice: number; realizedPnlSol: number; pctOfSize: number; reason: string }>> {
  return closePosition(intent, getPaperConfig(), paperPriceResolver);
}

export async function paperPartialClose(
  intent: PartialCloseIntent,
): Promise<ExecutionResult<{ exitPrice: number; realizedPnlSol: number; fraction: number; reason: string }>> {
  return partialClosePosition(intent, getPaperConfig(), paperPriceResolver);
}

export async function paperMarkToMarket(): Promise<{ positions: number; totalUnrealized: number }> {
  return markToMarket(paperPriceResolver);
}

export async function paperReset(
  intent: Omit<ResetIntent, "startSol"> & { startSol?: number },
): Promise<ExecutionResult<{ oldSessionId: bigint; newSessionId: bigint; closedPositions: number }>> {
  const config = getPaperConfig();
  return resetPortfolio(
    { ...intent, startSol: intent.startSol ?? config.startSol },
    paperPriceResolver,
  );
}

/** Read-only helpers for UI/API. */
export async function paperSnapshot() {
  const portfolio = await loadPortfolio();
  if (!portfolio) return null;
  const open = await loadOpenPositions(portfolio.sessionId);
  const todayLoss = await todayRealizedLossSol(portfolio.sessionId);
  return { portfolio, openPositions: open, todayLossSol: todayLoss };
}

export { loadOpenPositions, loadPortfolio } from "@spr/trading";
