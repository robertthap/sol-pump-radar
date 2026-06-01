import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { runEngineBEval, checkOpsHealthy } from "@/lib/continuation/eval-report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const ops = await checkOpsHealthy();
  const report = await runEngineBEval(ops);
  return NextResponse.json(report);
}
