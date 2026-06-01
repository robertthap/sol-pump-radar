import { NextResponse } from "next/server";
import { fetchPostgresRuntimeSnapshot } from "@/lib/runtime/postgres-read";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGet() {
  try {
    const snapshot = await fetchPostgresRuntimeSnapshot();
    return NextResponse.json({ ok: true, snapshot });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e), hint: "Is Docker Postgres up? pnpm db:up && pnpm db:migrate" },
      { status: 503 }
    );
  }
}

export const GET = withRoutePerf(handleGet);
