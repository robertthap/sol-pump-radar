import { parseProgramLogs, type ParsedPumpEvent } from "@/lib/pump/parser";

/**
 * T1.1b — Pure gap recovery for the v2 plan's WS Gap Recovery.
 *
 * Given a {fromSlot, toSlot} gap window and the list of at-risk mints (the
 * ones whose feature_snapshots / open positions / active universe membership
 * means a missed trade would corrupt a label), this function:
 *
 *   1. For each mint's bonding-curve PDA, pages getSignaturesForAddress
 *      newest→oldest with `until=<watermark sig>` so it stops at the last
 *      confirmed point. (Full-program replay is infeasible — millions of
 *      signatures per minute at peak. Per-mint via the curve PDA is bounded.)
 *   2. For each signature whose slot falls inside [fromSlot, toSlot], fetches
 *      the transaction and runs the existing parseProgramLogs decoder.
 *   3. Returns ParsedPumpEvent[] for the ingestor to insert via the normal
 *      path. ON CONFLICT DO NOTHING absorbs any overlap with live-streamed
 *      events at the gap edges.
 *
 * Discipline:
 *   - No DB writes here. Returning events keeps this module pure-ish (DI for
 *     the RPC client) and makes the unit tests trivially mockable.
 *   - One failing mint MUST NOT abort the rest of the batch. Errors per mint
 *     are caught and recorded in `failedMints`.
 *   - Backfilled events MUST NOT push to the chart WS (the ingestor wiring
 *     enforces this — they'd carry stale slots and trip the chart's
 *     canIncrement / sanitizeAscending guards).
 *
 * Edge cases the caller must handle:
 *   - If `mints.length === 0`, returns empty.
 *   - If the gap window is wider than EVENT_RETENTION_DAYS or otherwise too
 *     long to attempt, the CALLER should `markUnrecoverable` instead of
 *     calling this function (RPC budget protection).
 */

/** Minimal RPC interface — just what we need. Any @solana/web3.js Connection
 *  adapter, or a test mock, can satisfy it. */
export interface RpcClient {
  /**
   * Returns signatures for `address` ordered NEWEST → OLDEST. Pagination via
   * `before` (cursor). `until` stops the walk at a known signature.
   */
  getSignaturesForAddress(
    address: string,
    opts?: { before?: string; until?: string; limit?: number },
  ): Promise<Array<{
    signature: string; slot: number; blockTime: number | null;
    /** H06: non-null when the transaction REVERTED. Such a transaction never traded. */
    err?: unknown;
  }>>;

  /** Returns the parsed transaction with log messages, or null if not found. */
  getTransaction(
    signature: string,
  ): Promise<{
    slot: number;
    blockTime: number | null;
    /** H06: `meta.err` is non-null when the transaction reverted. */
    meta: { logMessages: string[] | null; err?: unknown } | null;
  } | null>;
}

export interface GapWindow {
  /** Inclusive lower bound — the last slot we DID consume before the gap. */
  fromSlot: bigint;
  /** Inclusive upper bound — current chain head when reconnect detected. */
  toSlot: bigint;
  /** Stop the per-mint signature walk at this signature (the watermark). */
  untilSig?: string | null;
}

export interface AtRiskMint {
  mint: string;
  bondingCurvePda: string;
}

export interface GapRecoveryResult {
  events: ParsedPumpEvent[];
  failedMints: string[];
  perMintRecovered: Map<string, number>;
}

/** Safety cap: never page more than this many signatures per mint. A single
 *  curve typically sees < 100 trades in a few minutes; 500 is a generous
 *  ceiling that protects RPC budget on pathological mints. */
const SIGNATURES_PAGE_LIMIT = 100;
const MAX_SIGNATURES_PER_MINT = 500;

/** Per-mint replay. Pages newest→oldest until a) the cursor passes BEFORE
 *  the gap window (slot < fromSlot), b) the `until` watermark, or c) the
 *  MAX_SIGNATURES_PER_MINT safety cap. */
async function recoverOneMint(
  rpc: RpcClient,
  gap: GapWindow,
  m: AtRiskMint,
): Promise<{ events: ParsedPumpEvent[]; count: number }> {
  const out: ParsedPumpEvent[] = [];
  let before: string | undefined;
  let scanned = 0;

  while (scanned < MAX_SIGNATURES_PER_MINT) {
    const page = await rpc.getSignaturesForAddress(m.bondingCurvePda, {
      before,
      until: gap.untilSig ?? undefined,
      limit: SIGNATURES_PAGE_LIMIT,
    });
    if (!page.length) break;
    scanned += page.length;

    let stopped = false;
    for (const sig of page) {
      const slot = BigInt(sig.slot);
      // Past the lower bound — we've walked into pre-gap territory. Stop.
      if (slot < gap.fromSlot) {
        stopped = true;
        break;
      }
      // Beyond the upper bound (live events that beat our gap close) — skip.
      if (slot > gap.toSlot) continue;

      // H06 — a REVERTED transaction never traded. pump.fun still emits log
      // messages up to the point of failure, so parsing them would manufacture
      // trades that never happened. The live WS path checks `n.err`; this is
      // the same guard for backfill. Checked here first so a known-failed
      // signature does not even cost an RPC round trip.
      if (sig.err != null) continue;

      const tx = await rpc.getTransaction(sig.signature);
      // Not every RPC returns `err` on the signature list, so re-check the
      // fetched transaction before trusting its logs.
      if (tx?.meta?.err != null) continue;
      const logs = tx?.meta?.logMessages ?? null;
      if (!logs || logs.length === 0) continue;
      // Unlike the live WS, replay CAN see the real chain time. Only claim
      // "chain" when the RPC actually returned one.
      const chainTs =
        typeof tx?.blockTime === "number" && Number.isFinite(tx.blockTime) ? tx.blockTime : null;
      const ts = chainTs ?? Math.floor(Date.now() / 1000);
      try {
        const parsed = parseProgramLogs(
          logs, sig.signature, slot, ts, chainTs != null ? "chain" : "local",
        );
        // Per-mint discipline: only keep events that actually belong to this
        // mint (the bonding-curve PDA's logs may include adjacent program
        // activity in edge cases).
        for (const ev of parsed) {
          if (ev.mint === m.mint) out.push(ev);
        }
      } catch {
        // decode failures isolated — one bad tx must not abort the batch
        continue;
      }
    }

    if (stopped) break;
    // Page is sorted newest→oldest; cursor is the last (oldest) signature.
    before = page[page.length - 1]!.signature;
    if (page.length < SIGNATURES_PAGE_LIMIT) break;
  }

  return { events: out, count: out.length };
}

/**
 * Recover events that fell into a WS coverage gap, scoped to the given
 * at-risk mints. Returns events for the caller to insert via the normal
 * insertEvents path (which dedups on (signature, instruction_index)).
 *
 * Never throws into the caller — partial failure returns what it got plus
 * the failed mints so the caller can log/retry per-mint without losing the
 * rest of the batch.
 */
export async function recoverGapForMints(
  rpc: RpcClient,
  gap: GapWindow,
  mints: AtRiskMint[],
): Promise<GapRecoveryResult> {
  const events: ParsedPumpEvent[] = [];
  const failedMints: string[] = [];
  const perMintRecovered = new Map<string, number>();
  if (mints.length === 0) return { events, failedMints, perMintRecovered };
  if (gap.toSlot < gap.fromSlot) return { events, failedMints, perMintRecovered };

  for (const m of mints) {
    try {
      const r = await recoverOneMint(rpc, gap, m);
      events.push(...r.events);
      perMintRecovered.set(m.mint, r.count);
    } catch {
      failedMints.push(m.mint);
    }
  }

  return { events, failedMints, perMintRecovered };
}
