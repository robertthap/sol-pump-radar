import { NextResponse } from "next/server";
import { z } from "zod";
import { bootDb } from "@/lib/db/client";
import { runBacktest } from "@/lib/backtest/runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ParamsSchema = z.object({
  windowHours: z.number().min(1).max(24 * 7).default(24),
  sizeSol: z.number().positive().max(10).default(0.05),
  takeProfitPct: z.number().positive().max(5).default(0.5),
  stopLossPct: z.number().positive().max(1).default(0.3),
  maxHoldMinutes: z.number().int().positive().max(240).default(30),
  actionFilter: z.array(z.enum(["BUY_STRONG", "BUY_MODERATE"])).default(["BUY_STRONG", "BUY_MODERATE"]),
  enableBotVetoes: z.boolean().default(true),
  enableRingVetoes: z.boolean().default(true),
  enableRugLabelVeto: z.boolean().default(true),
  enableEntryFilter: z.boolean().default(true),
  enableThreeGate: z.boolean().default(false),
  strongOnly: z.boolean().default(false),
  maxTrades: z.number().int().positive().max(2000).default(500),
  tp1Pct: z.number().min(0).max(5).optional(),
  tp1Fraction: z.number().min(0).max(0.95).optional(),
});

export async function POST(req: Request) {
  await bootDb();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = ParamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const summary = await runBacktest(parsed.data);
  return NextResponse.json(summary);
}
