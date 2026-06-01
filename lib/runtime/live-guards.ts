import "server-only";
import { readState } from "@/lib/circuit-breaker/state";
import { env, isLiveAllowed } from "@/lib/env";

/** Blocks live execution when halted or profile/confirm gates fail. */
export async function assertLiveExecutionAllowed(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const cb = await readState();
  if (cb.state === "HALTED") {
    return { ok: false, reason: "circuit_breaker_halted" };
  }
  const e = env();
  if (e.RUNTIME_PROFILE === "paper_safe") {
    return { ok: false, reason: "runtime_paper_safe" };
  }
  if (!isLiveAllowed() && e.LIVE_DRY_RUN !== "on") {
    return { ok: false, reason: "live_not_confirmed" };
  }
  return { ok: true };
}
