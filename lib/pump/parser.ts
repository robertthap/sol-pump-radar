import bs58 from "bs58";
import { BorshReader, safeNumber } from "@/lib/rpc/borsh";
import { EVENT_DISCRIMINATORS, PUMP_TOKEN_DECIMALS, SOL_DECIMALS } from "./program";

const PROGRAM_DATA_PREFIX = "Program data: ";
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
  vSolAfter: number;
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

export type ParsedPumpEvent = ParsedTradeEvent | ParsedCreateEvent | ParsedCompleteEvent;

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
    const isBuy = r.bool();
    const user = b58(r.pubkey());
    const ts = r.i64();
    const vSol = r.u64();
    r.u64();
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
      vSolAfter: safeNumber(vSol) / LAMPORTS_PER_SOL,
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
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
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
    if (disc.equals(EVENT_DISCRIMINATORS.trade)) {
      const ev = decodeTrade(body, ctx);
      if (ev) out.push(ev);
    } else if (disc.equals(EVENT_DISCRIMINATORS.create)) {
      const ev = decodeCreate(body, ctx);
      if (ev) out.push(ev);
    } else if (disc.equals(EVENT_DISCRIMINATORS.complete)) {
      const ev = decodeComplete(body, ctx);
      if (ev) out.push(ev);
    }
  }
  return out;
}
