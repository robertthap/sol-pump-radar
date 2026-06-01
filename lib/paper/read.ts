import "server-only";
import { loadPortfolio, loadOpenPositions, todayRealizedLossSol } from "@spr/trading";

/**
 * Read-only paper-engine helpers safe to import from web (no executor side
 * effects, no signing). The writer (paperOpen / paperClose / paperReset) lives
 * in @/lib/paper/engine which is worker-only.
 */
export async function paperSnapshot() {
  const portfolio = await loadPortfolio();
  if (!portfolio) return null;
  const open = await loadOpenPositions(portfolio.sessionId);
  const todayLoss = await todayRealizedLossSol(portfolio.sessionId);
  return { portfolio, openPositions: open, todayLossSol: todayLoss };
}
