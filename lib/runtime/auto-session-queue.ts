import "server-only";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { peekKeypair } from "@/lib/wallet/session";
import { env } from "@/lib/env";
import { readState } from "@/lib/circuit-breaker/state";

export type AutoQueueError = { status: number; error: string };

export async function validateAutoStart(
  modeHint?: "paper" | "live",
): Promise<{ ok: true; mode: "paper" | "live" } | AutoQueueError> {
  const existing = await getActiveSession();
  if (existing) {
    return { status: 409, error: "session_already_active" };
  }
  const cb = await readState();
  if (cb.state === "HALTED") {
    return { status: 400, error: "system is halted — resume first" };
  }
  const uiMode = await getUiTradingMode();
  const mode =
    modeHint === "live"
      ? "live"
      : modeHint === "paper"
        ? "paper"
        : uiMode === "real"
          ? "live"
          : "paper";
  if (mode === "live") {
    const e = env();
    if (e.LIVE_EXECUTION !== "on") {
      return {
        status: 400,
        error: "LIVE_EXECUTION is off — set LIVE_EXECUTION=on in .env to enable live mode",
      };
    }
    if (!peekKeypair()) {
      return { status: 400, error: "wallet not unlocked — unlock from the header first" };
    }
  }
  return { ok: true, mode };
}
