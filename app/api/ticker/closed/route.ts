import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchAutoSessionClosedPositionsSnapshot } from "@/lib/auto/session-positions";
import type {
  TickerClosedPosition,
  TickerClosedPositionsResponse,
} from "@/lib/auto/ticker-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Load the complete, immutable closed history only when the Closed tab needs it. */
export async function GET() {
  await bootDb();
  try {
    const snap = await fetchAutoSessionClosedPositionsSnapshot();
    const closedPositions: TickerClosedPosition[] = snap.closed.map((p) => ({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      name: p.name,
      source: p.source,
      sizeSol: p.sizeSol,
      entryMcapUsd: p.entryMcapUsd,
      exitMcapUsd: p.currentMcapUsd,
      pnlSol: p.pnlSol,
      exitReason: p.exitReason,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      strategyName: p.strategyName,
    }));
    const body: TickerClosedPositionsResponse = {
      sessionId: snap.sessionId,
      total: closedPositions.length,
      closedPositions,
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
