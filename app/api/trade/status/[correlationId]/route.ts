import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchEventsByCorrelationId } from "@/lib/runtime/domain-events-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Poll status for any queued command (trades, demo reset, settings, auto, phantom).
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ correlationId: string }> },
) {
  await bootDb();
  const { correlationId } = await ctx.params;
  if (!correlationId || correlationId.length < 8) {
    return NextResponse.json({ error: "invalid_correlation_id" }, { status: 400 });
  }

  const rows = await fetchEventsByCorrelationId(correlationId);
  if (rows.length === 0) {
    return NextResponse.json({ status: "unknown", correlationId }, { status: 404 });
  }

  const intent = rows.find(
    (r) =>
      r.type.endsWith("_REQUESTED") ||
      r.type.endsWith("_INTENT") ||
      r.type === "DEMO_RESET_REQUESTED",
  );
  const rejected = rows.find((r) => r.type.endsWith("_REJECTED"));
  const completed = rows.find((r) => r.type.endsWith("_COMPLETED") || r.type.endsWith("_RECORDED"));

  if (!completed) {
    return NextResponse.json({
      status: "pending",
      correlationId,
      intent: intent?.payload ?? null,
      submittedAt: intent?.occurredAt ?? null,
    });
  }

  const payload = completed.payload ?? {};
  const ok = payload.ok === true;
  let status: "completed" | "rejected" | "failed" = ok ? "completed" : "failed";
  if (!ok && rejected) status = "rejected";

  return NextResponse.json({
    status,
    correlationId,
    intent: intent?.payload ?? null,
    result: payload,
    rejected: rejected?.payload ?? null,
    submittedAt: intent?.occurredAt ?? null,
    completedAt: completed.occurredAt,
  });
}
