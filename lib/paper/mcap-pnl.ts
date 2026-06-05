/**
 * Pure PnL from REAL market caps (pure, web-safe — no DB/IO).
 *
 * The bonding-curve vSol model (lib/paper/math.ts) is only accurate while a coin
 * is on the curve AND only as accurate as the hardcoded SOL price. Once we have
 * the real USD market cap at entry and now (from pump.fun / DexScreener), PnL is
 * exact: token price ∝ market cap (fixed supply), so
 *
 *     pctOfSize = (currentMcap / entryMcap) · friction − 1
 *
 * where `friction` is the same round-trip fee/slippage haircut paperPnlSol uses,
 * so paper results stay comparable across the two paths.
 */
export function pnlFromMcap(opts: {
  sizeSol: number;
  entryMcapUsd: number;
  currentMcapUsd: number;
  pumpFeesPct: number;
  paperSlippagePct: number;
}): { pnlSol: number; ratio: number; pctOfSize: number } {
  if (
    !Number.isFinite(opts.entryMcapUsd) ||
    opts.entryMcapUsd <= 0 ||
    !Number.isFinite(opts.currentMcapUsd) ||
    opts.currentMcapUsd <= 0
  ) {
    return { pnlSol: 0, ratio: 1, pctOfSize: 0 };
  }
  const oneSide = 1 - opts.pumpFeesPct - opts.paperSlippagePct / 2;
  const friction = oneSide * oneSide;
  const ratio = (opts.currentMcapUsd / opts.entryMcapUsd) * friction;
  return { pnlSol: opts.sizeSol * (ratio - 1), ratio, pctOfSize: ratio - 1 };
}
