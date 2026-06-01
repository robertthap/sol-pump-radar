import "server-only";
import {
  paperConfigFromEnv,
  ensurePortfolio,
  loadPortfolio,
  loadOpenPositions,
  openPosition,
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

export async function paperOpen(
  intent: OpenIntent,
): Promise<ExecutionResult<{ positionId: bigint; fillPrice: number; slippageBps: number; latencyMs: number; feeSol: number }>> {
  return openPosition(intent, getPaperConfig(), paperPriceResolver);
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
