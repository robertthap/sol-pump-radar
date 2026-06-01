import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Legacy health endpoint — reads web-process memory, not worker Postgres heartbeats.
 * Use /api/runtime/health for authoritative automation health.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  url.pathname = "/api/runtime/health";
  return NextResponse.redirect(url, 308);
}
