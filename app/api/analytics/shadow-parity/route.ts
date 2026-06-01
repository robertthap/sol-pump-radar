import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchShadowParityPairs } from "@/lib/db/repos/analytics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Returns parity metrics between live trades and their shadow paper trades.
 */
export async function GET(req: Request) {
  await bootDb();
  const { searchParams } = new URL(req.url);
  const hours = Math.min(24 * 30, Math.max(1, Number(searchParams.get("hours") ?? "24")));

  const pairs = await fetchShadowParityPairs(hours);
  const closed = pairs.filter((p) => p.bothClosed);
  const slippages = closed.map((p) => p.slippageSol ?? 0).filter((x) => Number.isFinite(x));
  const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  const byRoute = new Map<string, { n: number; totalSlip: number }>();
  for (const p of closed) {
    if (p.slippageSol == null) continue;
    const k = p.route;
    const e = byRoute.get(k) ?? { n: 0, totalSlip: 0 };
    e.n++;
    e.totalSlip += p.slippageSol;
    byRoute.set(k, e);
  }

  return NextResponse.json({
    windowHours: hours,
    pairs,
    summary: {
      total: pairs.length,
      bothClosed: closed.length,
      avgSlippageSol: avg(slippages),
      worstSlippageSol: slippages.length === 0 ? 0 : Math.min(...slippages),
      bestSlippageSol: slippages.length === 0 ? 0 : Math.max(...slippages),
      paperPnlTotal: closed.reduce((a, b) => a + (b.paperPnl ?? 0), 0),
      livePnlTotal: closed.reduce((a, b) => a + (b.livePnl ?? 0), 0),
    },
    byRoute: Array.from(byRoute.entries()).map(([route, v]) => ({
      route,
      n: v.n,
      avgSlippageSol: v.n === 0 ? 0 : v.totalSlip / v.n,
    })),
  });
}
