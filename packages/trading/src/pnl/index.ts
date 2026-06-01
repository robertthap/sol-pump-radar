/**
 * Long-only PnL math (paper engine current scope). PnL is in SOL.
 * realized_pnl = (exit_price - entry_price) * quantity - fees
 * unrealized   = (current_price - entry_price) * quantity
 */

export function unrealizedPnlSol(
  entryPrice: number,
  currentPrice: number,
  quantity: number,
): number {
  return (currentPrice - entryPrice) * quantity;
}

export function realizedPnlSol(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  feesSol = 0,
): number {
  return (exitPrice - entryPrice) * quantity - feesSol;
}

export function pctOfSize(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (currentPrice - entryPrice) / entryPrice;
}
