import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { executeWebMutation, WebWriteOp } from "@/lib/runtime/web-writes";
import { setSignalModeOverride } from "@/lib/env";
import {
  SIGNAL_MODE_KEY,
  getStoredSignalMode,
  refreshSignalModeOverride,
  signalModeStatus,
  isSignalMode,
} from "@/lib/settings/signal-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  // Reflect the persisted choice in this (web) process before reporting it.
  const stored = await refreshSignalModeOverride();
  return NextResponse.json({ ...signalModeStatus(), stored });
}

export async function PUT(req: Request) {
  await bootDb();
  let body: { mode?: unknown };
  try {
    body = (await req.json()) as { mode?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isSignalMode(body.mode)) {
    return NextResponse.json({ error: "mode must be launch, hybrid, or profit" }, { status: 400 });
  }
  const mode = body.mode;
  await executeWebMutation(WebWriteOp.SETTINGS_SIGNAL_MODE, async (client) => {
    await client.query(
      `INSERT INTO user_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [SIGNAL_MODE_KEY, mode],
    );
  });
  // Apply immediately in the web process; the worker picks it up on its next refresh.
  setSignalModeOverride(mode);
  const stored = await getStoredSignalMode();
  return NextResponse.json({ ok: true, ...signalModeStatus(), stored });
}
