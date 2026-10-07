/**
 * The last gate before a real transaction reaches the network — PURE, no IO.
 *
 * Every existing LIVE check lives in a CALLER (assertLiveExecutionAllowed, the
 * web write gate, the executor's own preconditions). That is gating by
 * convention: it protects the paths someone remembered to gate, and a new code
 * path — a script, a worker lane, a retry helper, a future feature — reaches
 * `sendTransaction` with no check at all. Nothing structurally prevents it.
 *
 * This is the structural prevention. It sits INSIDE the broadcast and signing
 * choke points, so "no code path can send a real transaction while LIVE is off"
 * is a property of the code rather than a property of reviewer attention.
 *
 * It FAILS CLOSED. Anything it does not positively recognise as a fully
 * confirmed live configuration is refused. An unset flag, an unknown profile, a
 * typo in an env value — all blocked. The cost of a false block is an error
 * message; the cost of a false allow is real money.
 */

export type BroadcastFlags = {
  /** RUNTIME_PROFILE: only "live" may ever broadcast. */
  runtimeProfile: string | undefined;
  /** LIVE_EXECUTION: must be exactly "on". */
  liveExecution: string | undefined;
  /** LIVE_DRY_RUN: "on" means simulate only — it must NEVER broadcast. */
  liveDryRun: string | undefined;
  /** LIVE_CONFIRM token, which the operator sets deliberately. */
  liveConfirm: string | undefined;
};

export const LIVE_CONFIRM_TOKEN = "I_UNDERSTAND_REAL_MONEY";

export type BroadcastVerdict = { allowed: boolean; reason: string };

/**
 * May this configuration put a signed transaction on the network?
 *
 * Order matters only for the message; every condition must hold.
 */
export function mayBroadcast(flags: BroadcastFlags): BroadcastVerdict {
  if (flags.liveDryRun === "on") {
    // Checked first and separately: a dry run that broadcasts is the single
    // worst failure here, because the operator believes nothing can happen.
    return { allowed: false, reason: "live_dry_run_on" };
  }
  if (flags.runtimeProfile !== "live") {
    return { allowed: false, reason: `runtime_profile_${flags.runtimeProfile ?? "unset"}` };
  }
  if (flags.liveExecution !== "on") {
    return { allowed: false, reason: "live_execution_off" };
  }
  if (flags.liveConfirm !== LIVE_CONFIRM_TOKEN) {
    return { allowed: false, reason: "live_not_confirmed" };
  }
  return { allowed: true, reason: "live_confirmed" };
}

/** Thrown instead of broadcasting. Named so a catch cannot mistake it for RPC trouble. */
export class LiveBroadcastBlocked extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(
      `BLOCKED: refusing to broadcast a real transaction (${reason}). ` +
        `This is the central LIVE guard, not an RPC failure.`,
    );
    this.name = "LiveBroadcastBlocked";
    this.reason = reason;
  }
}

/** Throws unless the configuration is a fully confirmed live one. */
export function assertMayBroadcast(flags: BroadcastFlags): void {
  const verdict = mayBroadcast(flags);
  if (!verdict.allowed) throw new LiveBroadcastBlocked(verdict.reason);
}
