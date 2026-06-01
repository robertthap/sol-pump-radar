import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { paperSnapshot } from "@/lib/paper/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const snap = await paperSnapshot();
  if (!snap) {
    return NextResponse.json({ error: "portfolio not initialized — start `pnpm worker`" }, { status: 503 });
  }
  const { portfolio, openPositions, todayLossSol } = snap;
  return NextResponse.json({
    portfolio: {
      sessionId: portfolio.sessionId.toString(),
      balanceSol: portfolio.balanceSol,
      equitySol: portfolio.equitySol,
      realizedPnlSol: portfolio.realizedPnlSol,
      unrealizedPnlSol: portfolio.unrealizedPnlSol,
      peakEquitySol: portfolio.peakEquitySol,
      totalTrades: portfolio.totalTrades,
      wins: portfolio.wins,
      losses: portfolio.losses,
      drawdownSol: Math.max(0, portfolio.peakEquitySol - portfolio.equitySol),
      drawdownPct:
        portfolio.peakEquitySol > 0
          ? (portfolio.peakEquitySol - portfolio.equitySol) / portfolio.peakEquitySol
          : 0,
      winRate:
        portfolio.totalTrades > 0
          ? portfolio.wins / Math.max(1, portfolio.wins + portfolio.losses)
          : null,
      todayLossSol,
      updatedAt: portfolio.updatedAt,
    },
    openPositions: openPositions.map((p) => ({
      id: p.id.toString(),
      mint: p.mint,
      symbol: p.symbol,
      side: p.side,
      state: p.state,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      quantity: p.quantity,
      notionalSol: p.notionalSol,
      unrealizedPnlSol: p.unrealizedPnlSol,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      openedAt: p.openedAt,
    })),
  });
}
