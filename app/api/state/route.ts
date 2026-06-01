import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { readState } from "@/lib/circuit-breaker/state";

export const dynamic = "force-dynamic";

export async function GET() {
  await bootDb();
  const state = await readState();
  return NextResponse.json(state);
}
