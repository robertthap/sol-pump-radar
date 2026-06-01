import { mkdir, writeFile } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { getSlowQuerySamples } from "@/lib/db/query-metrics";
import { getWriteQueueStats } from "@/lib/db/write-queue";
import { getWorkerHeartbeats, getWorkerLastTickMs } from "@/lib/workers/heartbeat";
import { getIngestorStats } from "@/lib/rpc/stats";
import {
  buildPerfReport,
  recordClient,
  resetPerfStore,
  type ClientSample,
} from "@/lib/runtime/perf-tracker";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const probe = url.searchParams.get("probe") === "1";

  let dbPingMs: number | null = null;
  try {
    const t0 = Date.now();
    await bootDb();
    const { pingDb } = await import("@/lib/runtime/health-read");
    await pingDb();
    dbPingMs = Date.now() - t0;
  } catch (e) {
    dbPingMs = -1;
    noteProbeFail(String(e));
  }

  let postgresRuntime: Awaited<
    ReturnType<typeof import("@/lib/runtime/postgres-read").fetchPostgresRuntimeSnapshot>
  > | null = null;
  try {
    const { fetchPostgresRuntimeSnapshot, isPostgresRuntimeConfigured } = await import(
      "@/lib/runtime/postgres-read"
    );
    if (isPostgresRuntimeConfigured()) {
      postgresRuntime = await fetchPostgresRuntimeSnapshot();
    }
  } catch (e) {
    postgresRuntime = { configured: false as const };
    noteProbeFail("postgres runtime: " + String(e));
  }

  const report = buildPerfReport({
    dbPingMs,
    slowQueries: getSlowQuerySamples(20),
    dbWriteQueue: getWriteQueueStats(),
    workerHeartbeats: getWorkerHeartbeats(),
    workerLastTickMs: getWorkerLastTickMs(),
    ingestor: getIngestorStats(),
    postgresRuntime,
  });

  if (url.searchParams.get("reset") === "1") {
    resetPerfStore();
    return NextResponse.json({ ok: true, reset: true });
  }

  if (url.searchParams.get("save") === "1") {
    const dir = resolve(process.cwd(), "data", "diagnostics");
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, "runtime-latest.json");
    await writeFile(file, JSON.stringify(report, null, 2), "utf8");
    return NextResponse.json({
      ok: true,
      savedTo: file.replace(/\\/g, "/"),
      report,
    });
  }

  if (probe) {
    return NextResponse.json({
      ...report,
      probeHint: "Use browse UI then GET ?save=1 to capture a full session",
    });
  }

  return NextResponse.json(report);
}

async function handlePost(req: Request) {
  const body = (await req.json()) as {
    samples?: ClientSample[];
    path?: string;
    note?: string;
  };
  if (body.samples?.length) {
    recordClient(
      body.samples.map((s) => ({
        ...s,
        at: s.at ?? Date.now(),
      })),
    );
  }
  if (body.note) {
    const { notePerf } = await import("@/lib/runtime/perf-tracker");
    notePerf(`client: ${body.note}${body.path ? ` @ ${body.path}` : ""}`);
  }
  return NextResponse.json({ ok: true, received: body.samples?.length ?? 0 });
}

function noteProbeFail(err: string) {
  void import("@/lib/runtime/perf-tracker").then(({ notePerf }) =>
    notePerf(`db probe failed: ${err.slice(0, 200)}`),
  );
}

export const GET = withRoutePerf(handleGet);
export const POST = withRoutePerf(handlePost);
