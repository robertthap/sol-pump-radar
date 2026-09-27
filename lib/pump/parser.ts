import bs58 from "bs58";
import { BorshReader, safeNumber } from "@/lib/rpc/borsh";
import { EVENT_DISCRIMINATORS, PUMP_BONDING_CURVE_PROGRAM, PUMP_TOKEN_DECIMALS, SOL_DECIMALS } from "./program";
import { effectiveVSolFromReserves } from "./pumpswap-parser";

const PROGRAM_DATA_PREFIX = "Program data: ";
/** "Program <id> invoke [depth]" opens a frame; "... success" / "... failed" closes it. */
const INVOKE_RE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_RE = /^Program \w+ (success|failed)/;
const LAMPORTS_PER_SOL = 10 ** SOL_DECIMALS;
const TOKEN_BASE_UNITS = 10 ** PUMP_TOKEN_DECIMALS;

export type ParsedTradeEvent = {
  kind: "buy" | "sell";
  signature: string;
  slot: bigint;
  blockTime: number;
  /** Whether `blockTime` came from the chain or a local fallback. */
  tsSource: BlockTimeSource;
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  /**
   * Curve-equivalent vSol after the trade, derived from the event's virtual SOL AND
   * virtual token reserves (price = vSol / vTokens). Identical to the raw virtual
   * SOL reserve on the standard curve (30 SOL × 1.073B tokens); on curves with a
   * different constant (e.g. Mayhem-mode coins, whose virtual SOL starts near 0)
   * the raw reserve is on another scale entirely, so it is converted. Null when
   * either reserve is zero (no usable price).
   */
  vSolAfter: number | null;
};

export type ParsedCreateEvent = {
  kind: "create";
  signature: string;
  slot: bigint;
  blockTime: number;
  /** Whether `blockTime` came from the chain or a local fallback. */
  tsSource: BlockTimeSource;
  mint: string;
  wallet: string;
  name: string;
  symbol: string;
  uri: string;
  bondingCurve: string;
};

export type ParsedCompleteEvent = {
  kind: "migrate";
  signature: string;
  slot: bigint;
  blockTime: number;
  /** Whether `blockTime` came from the chain or a local fallback. */
  tsSource: BlockTimeSource;
  mint: string;
  wallet: string;
  bondingCurve: string;
};

/**
 * Position of this event within its transaction's decoded pump events, 0-based.
 *
 * One pump.fun transaction routinely emits MORE THAN ONE event: a create carries
 * the dev's first buy (CreateEvent + TradeEvent), and the buy that fills the
 * curve carries the graduation (TradeEvent + CompleteEvent). `events` is unique
 * on (signature, instruction_index), so writing every event at 0 meant the
 * second one hit ON CONFLICT DO NOTHING and vanished — measured 2026-09-27:
 * zero `migrate` rows in 1.09M signatures, and zero of 2,147 dev buys stored.
 *
 * The first event in a transaction keeps index 0, so rows written before this
 * existed keep their dedupe key and gap-recovery stays idempotent across the
 * change.
 */
export type WithLogIndex = { logIndex?: number };

export type ParsedPumpEvent = (ParsedTradeEvent | ParsedCreateEvent | ParsedCompleteEvent) & WithLogIndex;

function b58(buf: Buffer): string {
  return bs58.encode(buf);
}

/** Where a stored event timestamp came from: on-chain, or our local clock. */
export type BlockTimeSource = "chain" | "local";

/**
 * Normalize chain / log timestamps to unix seconds AND report which source the
 * value came from. When the on-chain time is missing or implausible we fall back
 * to the local clock — the two are indistinguishable once stored, so callers that
 * persist the value should also persist `source` (see events.ts_source). Without
 * it, any latency figure derived from events.ts silently mixes chain time with
 * receive time.
 */
export function classifyBlockTime(
  raw: number,
  fallbackSec: number,
): { sec: number; source: BlockTimeSource } {
  if (!Number.isFinite(raw) || raw <= 0) return { sec: fallbackSec, source: "local" };
  let sec = raw;
  if (sec > 1e12) sec = Math.floor(sec / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  if (sec < 1_000_000_000 || sec > nowSec + 120) return { sec: fallbackSec, source: "local" };
  return { sec: Math.floor(sec), source: "chain" };
}

/** Normalize chain / log timestamps to unix seconds for DB storage. */
export function normalizeBlockTimeSec(raw: number, fallbackSec: number): number {
  return classifyBlockTime(raw, fallbackSec).sec;
}

function decodeTrade(
  body: Buffer,
  ctx: { signature: string; slot: bigint; blockTime: number; blockTimeSource: BlockTimeSource },
): ParsedTradeEvent | null {
  try {
    const r = new BorshReader(body);
    const mint = b58(r.pubkey());
    const solAmount = r.u64();
    const tokenAmount = r.u64();
    const isBuyByte = r.u8();
    // A borsh bool is exactly 0 or 1. Anything else is another program's layout
    // that happens to share the "TradeEvent" discriminator.
    if (isBuyByte > 1) return null;
    const isBuy = isBuyByte === 1;
    const user = b58(r.pubkey());
    const ts = r.i64();
    const vSol = r.u64();
    const vTokens = r.u64();
    const bt = classifyBlockTime(safeNumber(ts), ctx.blockTime);
    return {
      kind: isBuy ? "buy" : "sell",
      signature: ctx.signature,
      slot: ctx.slot,
      blockTime: bt.sec,
      // If the event's own on-chain ts was usable this is genuinely chain time.
      // If we fell back to ctx.blockTime, provenance is whatever the CALLER's
      // fallback was (local for the live WS, chain for gap recovery replaying a
      // real tx.blockTime) — never re-inferred from how plausible the number looks.
      tsSource: bt.source === "chain" ? "chain" : ctx.blockTimeSource,
      mint,
      wallet: user,
      side: isBuy ? "buy" : "sell",
      solAmount: safeNumber(solAmount) / LAMPORTS_PER_SOL,
      tokenAmount: safeNumber(tokenAmount) / TOKEN_BASE_UNITS,
      vSolAfter: effectiveVSolFromReserves(safeNumber(vSol) / LAMPORTS_PER_SOL, safeNumber(vTokens)),
    };
  } catch {
    return null;
  }
}

function decodeCreate(
  body: Buffer,
  ctx: { signature: string; slot: bigint; blockTime: number; blockTimeSource: BlockTimeSource },
): ParsedCreateEvent | null {
  try {
    const r = new BorshReader(body);
    const name = r.string();
    const symbol = r.string();
    const uri = r.string();
    const mint = b58(r.pubkey());
    const bondingCurve = b58(r.pubkey());
    const user = b58(r.pubkey());
    return {
      kind: "create",
      signature: ctx.signature,
      slot: ctx.slot,
      blockTime: ctx.blockTime,
      // No on-chain ts in this event: provenance is the caller's fallback.
      tsSource: ctx.blockTimeSource,
      mint,
      wallet: user,
      name: name.slice(0, 96),
      symbol: symbol.slice(0, 32),
      uri: uri.slice(0, 512),
      bondingCurve,
    };
  } catch {
    return null;
  }
}

function decodeComplete(
  body: Buffer,
  ctx: { signature: string; slot: bigint; blockTime: number; blockTimeSource: BlockTimeSource },
): ParsedCompleteEvent | null {
  try {
    const r = new BorshReader(body);
    const user = b58(r.pubkey());
    const mint = b58(r.pubkey());
    const bondingCurve = b58(r.pubkey());
    return {
      kind: "migrate",
      signature: ctx.signature,
      slot: ctx.slot,
      blockTime: ctx.blockTime,
      // No on-chain ts in this event: provenance is the caller's fallback.
      tsSource: ctx.blockTimeSource,
      mint,
      wallet: user,
      bondingCurve,
    };
  } catch {
    return null;
  }
}

export function parseProgramLogs(
  logs: string[],
  signature: string,
  slot: bigint,
  blockTime: number,
  /** Provenance of `blockTime`. Defaults to "local" so a caller that does not
   *  know can never accidentally claim chain time. */
  blockTimeSource: BlockTimeSource = "local",
): ParsedPumpEvent[] {
  const out: ParsedPumpEvent[] = [];
  const ctx = { signature, slot, blockTime, blockTimeSource };
  // Track which program is executing so only pump.fun's own events are decoded.
  // A transaction's logs include every program it touches, and other launchpads
  // (e.g. Raydium LaunchLab) emit a "TradeEvent" with the same Anchor
  // discriminator but a different layout — decoding those as pump trades stored
  // fabricated rows (793,100 SOL buys, vSol 9,007,199). Lines with no invoke
  // context at all (hand-built inputs) are still accepted.
  const invokeStack: string[] = [];
  for (const line of logs) {
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      invokeStack.push(invoke[1]!);
      continue;
    }
    if (EXIT_RE.test(line)) {
      invokeStack.pop();
      continue;
    }
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const emitter = invokeStack[invokeStack.length - 1];
    if (emitter != null && emitter !== PUMP_BONDING_CURVE_PROGRAM) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length);
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    const body = buf.subarray(8);
    // logIndex is the event's position among THIS transaction's pump events —
    // what keeps a create and its dev buy, or a final buy and its graduation,
    // from colliding on (signature, instruction_index).
    if (disc.equals(EVENT_DISCRIMINATORS.trade)) {
      const ev = decodeTrade(body, ctx);
      if (ev) out.push({ ...ev, logIndex: out.length });
    } else if (disc.equals(EVENT_DISCRIMINATORS.create)) {
      const ev = decodeCreate(body, ctx);
      if (ev) out.push({ ...ev, logIndex: out.length });
    } else if (disc.equals(EVENT_DISCRIMINATORS.complete)) {
      const ev = decodeComplete(body, ctx);
      if (ev) out.push({ ...ev, logIndex: out.length });
    }
  }
  return out;
}
