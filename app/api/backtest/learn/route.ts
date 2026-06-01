import { NextResponse } from "next/server";
import { z } from "zod";
import { bootDb } from "@/lib/db/client";
import { runBacktestLearn } from "@/lib/backtest/learn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const BodySchema = z.object({
  windowHours: z.number().min(1).max(24 * 7).default(24),
  sizeSol: z.number().positive().max(10).default(0.05),
  maxTrades: z.number().int().positive().max(2000).default(400),
  enableBotVetoes: z.boolean().default(true),
  enableRingVetoes: z.boolean().default(true),
  enableRugLabelVeto: z.boolean().default(true),
});

export async function POST(req: Request) {
  await bootDb();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await runBacktestLearn(parsed.data);
  return NextResponse.json(result);
}
