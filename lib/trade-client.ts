/**
 * Client-side helper for queued live trade intents.
 *
 * The /api/trade/quick-buy and /api/trade/quick-sell routes are now queue-only.
 * They return 202 with { ok, queued, correlationId, statusUrl }. The worker
 * processes the intent and writes LIVE_TRADE_COMPLETED with the outcome.
 * Callers poll this helper to get the same shape they expected before.
 */

export type SubmittedTradeResult = {
  ok: boolean;
  dryRun: boolean;
  signature: string | null;
  simulatedSignature: string | null;
  route: string | null;
  tradeId: string | null;
  error: string | null;
  correlationId: string;
};

type IntentBody = {
  mint: string;
  sizeSol?: number;
  percent?: number;
  vSol?: number;
};

const POLL_MS = 750;
const TIMEOUT_MS = 30_000;

export type DemoTradeResult = {
  ok: boolean;
  side: "buy" | "sell";
  tradeId: string | null;
  pnlSol: number | null;
  entryVSol: number | null;
  error: string | null;
  correlationId: string;
};

export async function pollCommandStatus(correlationId: string): Promise<{
  ok: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
}> {
  const polled = await pollIntentStatus(correlationId);
  return {
    ok: polled.ok,
    result: polled.ok
      ? {
          tradeId: polled.tradeId,
          session: polled.session,
          pnlSol: polled.pnlSol,
          entryVSol: polled.entryVSol,
          dryRun: polled.dryRun,
          signature: polled.signature,
          simulatedSignature: polled.simulatedSignature,
          route: polled.route,
        }
      : null,
    error: polled.error,
  };
}

/** POST a queued command route (202) and poll until worker completes. */
export async function postQueuedCommand(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await fetch(url, init);
  if (r.status === 202) {
    const j = (await r.json()) as { correlationId?: string };
    if (!j.correlationId) return { ok: false, error: "missing_correlation_id" };
    const polled = await pollCommandStatus(j.correlationId);
    return { ok: polled.ok, error: polled.error };
  }
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error ?? `http_${r.status}` };
  }
  return { ok: true, error: null };
}

async function pollIntentStatus(correlationId: string): Promise<{
  ok: boolean;
  tradeId: string | null;
  pnlSol: number | null;
  entryVSol: number | null;
  error: string | null;
  dryRun: boolean;
  signature: string | null;
  simulatedSignature: string | null;
  route: string | null;
  session?: unknown;
}> {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const r = await fetch(`/api/trade/status/${encodeURIComponent(correlationId)}`, {
      cache: "no-store",
    });
    if (r.status === 404) {
      return {
        ok: false,
        tradeId: null,
        pnlSol: null,
        entryVSol: null,
        error: "intent_not_found",
        dryRun: false,
        signature: null,
        simulatedSignature: null,
        route: null,
      };
    }
    const j = (await r.json()) as {
      status?: string;
      result?: {
        ok?: boolean;
        tradeId?: string | null;
        session?: unknown;
        pnlSol?: number | null;
        entryVSol?: number | null;
        fillPrice?: number | null;
        error?: string | null;
        reason?: string | null;
        dryRun?: boolean;
        signature?: string | null;
        simulatedSignature?: string | null;
        route?: string | null;
      } | null;
      rejected?: { reason?: string } | null;
    };
    if (j.status === "pending") {
      await new Promise((res) => setTimeout(res, POLL_MS));
      continue;
    }
    const res = j.result ?? {};
    return {
      ok: res.ok === true,
      tradeId: res.tradeId ?? null,
      session: res.session,
      pnlSol: typeof res.pnlSol === "number" ? res.pnlSol : null,
      entryVSol:
        typeof res.entryVSol === "number"
          ? res.entryVSol
          : typeof res.fillPrice === "number"
            ? res.fillPrice
            : null,
      error: (res.error ?? res.reason ?? j.rejected?.reason ?? null) as string | null,
      dryRun: res.dryRun === true,
      signature: res.signature ?? null,
      simulatedSignature: res.simulatedSignature ?? null,
      route: res.route ?? null,
    };
  }
  return {
    ok: false,
    tradeId: null,
    pnlSol: null,
    entryVSol: null,
    error: "timeout_waiting_for_worker",
    dryRun: false,
    signature: null,
    simulatedSignature: null,
    route: null,
  };
}

export type DemoResetResult = {
  ok: boolean;
  error: string | null;
  correlationId: string;
};

/**
 * Reset the demo account, optionally to a new starting balance.
 *
 * `startSol` omitted means keep whatever the account is already set to — a
 * reset should not silently change the stake. When given, it is applied in the
 * SAME request as the reset, so the new balance and the wipe land together
 * rather than as two states an observer could catch in between.
 */
export async function submitDemoReset(startSol?: number): Promise<DemoResetResult> {
  let r: Response;
  try {
    r = await fetch("/api/settings/mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        startSol != null ? { resetDemo: true, demoStartSol: startSol } : { resetDemo: true },
      ),
    });
  } catch (e) {
    const msg =
      e instanceof TypeError
        ? "Cannot reach the app server — start it with pnpm dev and ensure the worker is running."
        : String(e);
    return { ok: false, error: msg, correlationId: "" };
  }
  if (r.status === 202) {
    const j = (await r.json()) as { correlationId?: string };
    if (!j.correlationId) {
      return { ok: false, error: "missing_correlation_id", correlationId: "" };
    }
    const polled = await pollIntentStatus(j.correlationId);
    return {
      ok: polled.ok,
      error: polled.error,
      correlationId: j.correlationId,
    };
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: j.error ?? `http_${r.status}`, correlationId: "" };
}

export async function submitDemoTrade(body: {
  mint: string;
  side: "buy" | "sell";
  sizeSol?: number;
  vSol?: number;
}): Promise<DemoTradeResult> {
  const r = await fetch("/api/trade/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 202) {
    const j = (await r.json()) as { correlationId?: string; side?: "buy" | "sell" };
    if (!j.correlationId) {
      return {
        ok: false,
        side: body.side,
        tradeId: null,
        pnlSol: null,
        entryVSol: null,
        error: "missing_correlation_id",
        correlationId: "",
      };
    }
    const polled = await pollIntentStatus(j.correlationId);
    return {
      ok: polled.ok,
      side: j.side ?? body.side,
      tradeId: polled.tradeId,
      pnlSol: polled.pnlSol,
      entryVSol: polled.entryVSol,
      error: polled.error,
      correlationId: j.correlationId,
    };
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return {
    ok: false,
    side: body.side,
    tradeId: null,
    pnlSol: null,
    entryVSol: null,
    error: j.error ?? `http_${r.status}`,
    correlationId: "",
  };
}

export async function submitAutoQuickStart(body: {
  preset?: string;
  sizeSol?: number;
  maxDailyLossSol?: number;
  maxConcurrent?: number;
  researchExecution?: "OPTIMISTIC" | "BASE" | "CONSERVATIVE";
}): Promise<{ ok: boolean; error: string | null; correlationId: string }> {
  const r = await fetch("/api/auto/quick-start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 202) {
    const j = (await r.json()) as { correlationId?: string };
    if (!j.correlationId) {
      return { ok: false, error: "missing_correlation_id", correlationId: "" };
    }
    const polled = await pollIntentStatus(j.correlationId);
    return { ok: polled.ok, error: polled.error, correlationId: j.correlationId };
  }
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; alreadyActive?: boolean };
  if (j.alreadyActive) return { ok: true, error: null, correlationId: "" };
  return { ok: j.ok === true, error: j.error ?? `http_${r.status}`, correlationId: "" };
}

export async function submitAutoStop(reason?: string): Promise<{ ok: boolean; error: string | null }> {
  const r = await fetch("/api/auto/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (r.status === 202) {
    const j = (await r.json()) as { correlationId?: string };
    if (!j.correlationId) return { ok: false, error: "missing_correlation_id" };
    const polled = await pollIntentStatus(j.correlationId);
    return { ok: polled.ok, error: polled.error };
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: r.ok, error: j.error ?? null };
}

export async function submitSellAll(opts?: {
  scope?: "all" | "auto";
  sessionId?: string;
}): Promise<{
  ok: boolean;
  closedCount: number;
  failedCount: number;
  totalPnlSol: number | null;
  error: string | null;
  correlationId: string;
}> {
  const r = await fetch("/api/trade/sell-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  const j = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    queued?: boolean;
    correlationId?: string;
    correlationIds?: string[];
    closedCount?: number;
    message?: string;
    error?: string;
  };

  if (r.ok && !j.queued) {
    return {
      ok: true,
      closedCount: j.closedCount ?? 0,
      failedCount: 0,
      totalPnlSol: 0,
      error: null,
      correlationId: "",
    };
  }

  if (r.status === 202 && j.correlationId) {
    const polled = await pollIntentStatus(j.correlationId);
    const statusRes = await fetch(`/api/trade/status/${encodeURIComponent(j.correlationId)}`, {
      cache: "no-store",
    });
    const statusJ = (await statusRes.json().catch(() => ({}))) as {
      result?: Record<string, unknown>;
    };
    const payload = statusJ.result ?? {};
    return {
      ok: polled.ok,
      closedCount: Number(payload.closedCount ?? 0),
      failedCount: Number(payload.failedCount ?? 0),
      totalPnlSol:
        payload.totalPnlSol != null && Number.isFinite(Number(payload.totalPnlSol))
          ? Number(payload.totalPnlSol)
          : null,
      error: polled.error,
      correlationId: j.correlationId,
    };
  }

  if (r.status === 202 && j.correlationIds?.length) {
    const results = await Promise.all(j.correlationIds.map((id) => pollIntentStatus(id)));
    const closedCount = results.filter((x) => x.ok).length;
    const failedCount = results.length - closedCount;
    const totalPnlSol = results.reduce((sum, x) => sum + (x.pnlSol ?? 0), 0);
    const firstErr = results.find((x) => !x.ok)?.error ?? null;
    return {
      ok: closedCount > 0,
      closedCount,
      failedCount,
      totalPnlSol: closedCount > 0 ? totalPnlSol : null,
      error: closedCount === 0 ? firstErr : null,
      correlationId: j.correlationIds[0] ?? "",
    };
  }

  return {
    ok: false,
    closedCount: 0,
    failedCount: 0,
    totalPnlSol: null,
    error: j.error ?? `http_${r.status}`,
    correlationId: "",
  };
}

export async function submitLiveTrade(
  path: "/api/trade/quick-buy" | "/api/trade/quick-sell",
  body: IntentBody,
): Promise<SubmittedTradeResult> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 202) {
    const j = (await r.json()) as { correlationId?: string };
    if (!j.correlationId) {
      return {
        ok: false,
        dryRun: false,
        signature: null,
        simulatedSignature: null,
        route: null,
        tradeId: null,
        error: "missing_correlation_id",
        correlationId: "",
      };
    }
    const polled = await pollIntentStatus(j.correlationId);
    return {
      ok: polled.ok,
      dryRun: polled.dryRun,
      signature: polled.signature,
      simulatedSignature: polled.simulatedSignature,
      route: polled.route,
      tradeId: polled.tradeId,
      error: polled.error,
      correlationId: j.correlationId,
    };
  }
  const j = (await r.json().catch(() => ({}))) as {
    error?: string;
    hint?: string;
  };
  return {
    ok: false,
    dryRun: false,
    signature: null,
    simulatedSignature: null,
    route: null,
    tradeId: null,
    error: j.error ?? `http_${r.status}`,
    correlationId: "",
  };
}
