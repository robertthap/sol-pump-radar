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
  mint: string;
  wallet: string;
  bondingCurve: string;
};

export type ParsedPumpEvent = ParsedTradeEvent | ParsedCreateEvent | ParsedCompleteEvent;

function b58(buf: Buffer): string {
  return bs58.encode(buf);
}

/** Normalize chain / log timestamps to unix seconds for DB storage. */
export function normalizeBlockTimeSec(raw: number, fallbackSec: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallbackSec;
  let sec = raw;
  if (sec > 1e12) sec = Math.floor(sec / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  if (sec < 1_000_000_000 || sec > nowSec + 120) return fallbackSec;
  return Math.floor(sec);
}

function decodeTrade(
  body: Buffer,
  ctx: { signature: string; slot: bigint; blockTime: number },
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
    return {
      kind: isBuy ? "buy" : "sell",
      signature: ctx.signature,
      slot: ctx.slot,
      blockTime: normalizeBlockTimeSec(safeNumber(ts), ctx.blockTime),
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
  ctx: { signature: string; slot: bigint; blockTime: number },
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
  ctx: { signature: string; slot: bigint; blockTime: number },
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
): ParsedPumpEvent[] {
  const out: ParsedPumpEvent[] = [];
  const ctx = { signature, slot, blockTime };
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
