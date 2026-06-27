import bs58 from "bs58";
import { BorshReader, safeNumber } from "@/lib/rpc/borsh";
import { PUMP_SWAP_DISCRIMINATORS, SOL_DECIMALS, PUMP_TOKEN_DECIMALS } from "./program";
import { CURVE_DIV } from "@/lib/dex/curve-mcap";
import { PUMP_SUPPLY } from "@/lib/chart/constants";

const PROGRAM_DATA_PREFIX = "Program data: ";
const LAMPORTS_PER_SOL = 10 ** SOL_DECIMALS;
const TOKEN_BASE_UNITS = 10 ** PUMP_TOKEN_DECIMALS;

/**
 * PumpSwap (pump-amm) swap parser — T1.2b. Decodes Buy/Sell events emitted by
 * the PumpSwap AMM program after a coin graduates from the bonding curve.
 *
 * IMPORTANT — this is the PURE, fixture-tested half. It extracts the raw event
 * fields with NO RPC and NO mint resolution. The event does not carry the
 * base/quote mint identity, so it cannot know which leg is SOL vs the meme
 * token, nor the user's buy/sell side. That enrichment (pool→mint lookup +
 * effective-vSol derivation) happens async in the ingestor. See
 * lib/pump/__fixtures__/PUMPSWAP_LAYOUT.md for the full byte map + validation.
 *
 * Field layout (after 8-byte discriminator), little-endian — validated against
 * on-chain SOL/token balance deltas for 4 real txs.
 */

export type RawSwapEvent = {
  eventType: "buy" | "sell"; // the POOL action — NOT the user's side
  signature: string;
  /** Index of this swap event among the swap events in its transaction. Used as
   *  the events table's instruction_index so co-signature swaps don't collide. */
  logIndex: number;
  slot: bigint;
  blockTime: number;
  /** base-token leg amount (raw units). Which mint this is depends on the pool. */
  baseAmount: number;
  /** quote-token leg amount (raw units). */
  quoteAmount: number;
  /** Pool reserves AFTER the swap (raw units). */
  poolBaseReserves: number;
  poolQuoteReserves: number;
  /** The pool account address — used to resolve base/quote mints. */
  pool: string;
  /** The trader. */
  user: string;
};

function decodeSwap(
  body: Buffer,
  eventType: "buy" | "sell",
  logIndex: number,
  ctx: { signature: string; slot: bigint; blockTime: number },
): RawSwapEvent | null {
  try {
    const r = new BorshReader(body);
    r.i64();                                   // timestamp
    const baseAmount = safeNumber(r.u64());    // base_amount_out / base_amount_in
    r.u64();                                   // slippage (max_quote_in / min_quote_out)
    r.u64();                                   // user_base_token_reserves
    r.u64();                                   // user_quote_token_reserves
    const poolBaseReserves = safeNumber(r.u64());
    const poolQuoteReserves = safeNumber(r.u64());
    const quoteAmount = safeNumber(r.u64());   // quote_amount_in / quote_amount_out
    r.u64();                                   // lp_fee_basis_points
    r.u64();                                   // lp_fee
    r.u64();                                   // protocol_fee_basis_points
    r.u64();                                   // protocol_fee
    r.u64();                                   // quote_amount_with_lp_fee
    r.u64();                                   // user_quote_amount
    const pool = bs58Pubkey(r);
    const user = bs58Pubkey(r);
    return {
      eventType,
      signature: ctx.signature,
      logIndex,
      slot: ctx.slot,
      blockTime: ctx.blockTime,
      baseAmount,
      quoteAmount,
      poolBaseReserves,
      poolQuoteReserves,
      pool,
      user,
    };
  } catch {
    return null;
  }
}

function bs58Pubkey(r: BorshReader): string {
  return bs58.encode(r.pubkey());
}

/**
 * Effective vSol from PumpSwap pool reserves — pure, SOL-price-INDEPENDENT.
 *
 * The bonding-curve mcap is `mcap_sol = vSol² / CURVE_DIV`, so inverting a DEX
 * pool's spot mcap gives the curve-equivalent vSol that the quadratic PnL model
 * consumes unchanged. Crucially the SOL/USD rate cancels (mcap and the inverse
 * both scale by it), so we work in pure SOL terms — no async price dependency,
 * and PnL/labels stay continuous across the graduation boundary.
 *
 *   price_sol_per_token = solReserveSol / tokenReserveWhole
 *   mcap_sol            = price_sol_per_token × PUMP_SUPPLY
 *   effectiveVSol       = sqrt(mcap_sol × CURVE_DIV)
 */
export function effectiveVSolFromReserves(
  solReserveSol: number,
  tokenReserveRaw: number,
): number | null {
  const tokenWhole = tokenReserveRaw / TOKEN_BASE_UNITS;
  if (!(solReserveSol > 0) || !(tokenWhole > 0)) return null;
  const priceSolPerToken = solReserveSol / tokenWhole;
  const mcapSol = priceSolPerToken * PUMP_SUPPLY;
  const vSol = Math.sqrt(mcapSol * CURVE_DIV);
  return Number.isFinite(vSol) && vSol > 0 ? vSol : null;
}

/**
 * Parse PumpSwap Buy/Sell events out of a transaction's program logs. Returns
 * RAW events (no mint, no side, no vSol) — the ingestor resolves those. Mirrors
 * the curve parser's decode-error isolation: a malformed line is skipped, never
 * thrown.
 */
export function parseSwapLogs(
  logs: string[],
  signature: string,
  slot: bigint,
  blockTime: number,
): RawSwapEvent[] {
  const out: RawSwapEvent[] = [];
  const ctx = { signature, slot, blockTime };
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), "base64");
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    const body = buf.subarray(8);
    if (disc.equals(PUMP_SWAP_DISCRIMINATORS.buy)) {
      const ev = decodeSwap(body, "buy", out.length, ctx);
      if (ev) out.push(ev);
    } else if (disc.equals(PUMP_SWAP_DISCRIMINATORS.sell)) {
      const ev = decodeSwap(body, "sell", out.length, ctx);
      if (ev) out.push(ev);
    }
  }
  return out;
}

/**
 * Enrich a raw swap event into the canonical trade record, given the pool's
 * mint ordering. Pure — the caller supplies `baseIsWsol` (from a cached pool
 * lookup). This is the half that maps base/quote → SOL/token and resolves the
 * user's true side. See PUMPSWAP_LAYOUT.md.
 */
export type EnrichedSwap = {
  mint: string;
  wallet: string;
  side: "buy" | "sell";       // USER's perspective
  solAmount: number;          // in SOL
  tokenAmount: number;        // in whole tokens (caller applies decimals if needed)
  /** SOL reserve in the pool AFTER the swap (in SOL). */
  solReserveAfter: number;
  /** Token reserve in the pool AFTER the swap (raw units). */
  tokenReserveAfter: number;
  signature: string;
  slot: bigint;
  blockTime: number;
  pool: string;
};

export function enrichSwap(
  raw: RawSwapEvent,
  opts: { memeMint: string; baseIsWsol: boolean },
): EnrichedSwap {
  const { baseIsWsol } = opts;
  const solRaw = baseIsWsol ? raw.baseAmount : raw.quoteAmount;
  const tokenRaw = baseIsWsol ? raw.quoteAmount : raw.baseAmount;
  const solReserveRaw = baseIsWsol ? raw.poolBaseReserves : raw.poolQuoteReserves;
  const tokenReserveAfter = baseIsWsol ? raw.poolQuoteReserves : raw.poolBaseReserves;
  // The event type is the POOL action; the user's side is the opposite-aware:
  // user receives meme  <=>  (BuyEvent && base==meme) || (SellEvent && base==wsol)
  const userReceivesMeme =
    (raw.eventType === "buy" && !baseIsWsol) || (raw.eventType === "sell" && baseIsWsol);
  const side: "buy" | "sell" = userReceivesMeme ? "buy" : "sell";
  return {
    mint: opts.memeMint,
    wallet: raw.user,
    side,
    solAmount: solRaw / LAMPORTS_PER_SOL,
    tokenAmount: tokenRaw,
    solReserveAfter: solReserveRaw / LAMPORTS_PER_SOL,
    tokenReserveAfter,
    signature: raw.signature,
    slot: raw.slot,
    blockTime: raw.blockTime,
    pool: raw.pool,
  };
}
