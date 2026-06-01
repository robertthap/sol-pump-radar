import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { buildAutoDiagnostics } from "@/lib/auto/diagnostics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const diagnostics = await cached("auto:diagnostics", 10_000, () => buildAutoDiagnostics());
  return NextResponse.json(diagnostics);
}
