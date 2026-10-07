import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { bootDb } from "@/lib/db/client";
import { cached, invalidateCache } from "@/lib/api/short-cache";
import {
  fetchDemoAccount,
  getUiTradingMode,
  hasActiveTradingSession,
  type UiTradingMode,
} from "@/lib/db/repos/trading-mode";
import { executeWebMutation, WebWriteOp } from "@/lib/runtime/web-writes";
import { env } from "@/lib/env";
import { getStatus } from "@/lib/wallet/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  return NextResponse.json(
    await cached("settings:mode-full", 5_000, async () => {
      const mode = await getUiTradingMode();
      const demo = await fetchDemoAccount();
      const wallet = await getStatus();
      const activeSession = await hasActiveTradingSession(mode);
      const e = env();
      return {
        mode,
        needsSelection: mode == null,
        activeSession,
        demo,
        real: {
          walletUnlocked: wallet.isUnlocked,
          hasWallet: wallet.hasWallet,
          liveExecution: e.LIVE_EXECUTION,
          liveDryRun: e.LIVE_DRY_RUN,
        },
        shadowLearner: {
          enabled: e.SHADOW_LEARNER === "on",
          sizeSol: e.SHADOW_LEARN_SIZE_SOL,
        },
      };
    }),
  );
}

type PutBody = {
  mode?: UiTradingMode;
  demoStartSol?: number;
  resetDemo?: boolean;
  clearSession?: boolean;
};

export async function PUT(req: Request) {
  await bootDb();
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.clearSession === true || body.mode != null || body.demoStartSol != null) {
    if (body.mode != null && body.mode !== "demo" && body.mode !== "real") {
      return NextResponse.json({ error: "mode must be demo or real" }, { status: 400 });
    }
    if (body.demoStartSol != null && (body.demoStartSol <= 0 || body.demoStartSol > 10_000)) {
      return NextResponse.json({ error: "demo_start_sol out of range" }, { status: 400 });
    }
    const correlationId = `settings-mode-${randomUUID()}`;
    await executeWebMutation(WebWriteOp.SETTINGS_MODE, async (client) => {
      await client.query(
        `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
         VALUES ('SETTINGS_MODE_REQUESTED', $1::jsonb, $2, $3)`,
        [
          JSON.stringify({
            mode: body.mode ?? undefined,
            demoStartSol: body.demoStartSol ?? undefined,
            clearSession: body.clearSession === true ? true : undefined,
            strategy_id: "operator",
          }),
          `settings:mode-req:${correlationId}`,
          correlationId,
        ],
      );
    });
    invalidateCache("settings:mode");
    invalidateCache("settings:mode-lite");
    // Fall THROUGH when a reset was asked for in the same request. This block
    // used to return unconditionally, so {resetDemo:true, demoStartSol:N} set
    // the balance and silently dropped the reset — the caller got a 202 and no
    // wipe. The settings event is queued first, so the worker applies the new
    // starting balance before the reset that uses it.
    if (body.resetDemo !== true) {
      return NextResponse.json(
        { ok: true, queued: true, correlationId, statusUrl: `/api/trade/status/${correlationId}` },
        { status: 202 },
      );
    }
  }
  if (body.resetDemo === true) {
    const correlationId = `demo-reset-${randomUUID()}`;
    try {
      await executeWebMutation(WebWriteOp.DEMO_RESET_REQUEST, async (client) => {
        await client.query(
          `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
           VALUES ('DEMO_RESET_REQUESTED', $1::jsonb, $2, $3)`,
          [
            JSON.stringify({ strategy_id: "manual_demo_reset" }),
            `demo:reset-req:${correlationId}`,
            correlationId,
          ],
        );
      });
      invalidateCache("settings:mode");
      invalidateCache("settings:mode-lite");
      return NextResponse.json(
        {
          ok: true,
          queued: true,
          correlationId,
          statusUrl: `/api/trade/status/${correlationId}`,
        },
        { status: 202 },
      );
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }
  const mode = await getUiTradingMode();
  const demo = await fetchDemoAccount();
  return NextResponse.json({ ok: true, mode, demo });
}
