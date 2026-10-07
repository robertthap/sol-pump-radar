/**
 * Exact integer money (M04) — PURE, no IO.
 *
 * Lamports and raw token amounts are INTEGERS on chain. Carrying them as JS
 * doubles is safe only up to 2^53-1, and pump.fun amounts get uncomfortably
 * close: a 1e9-supply token with 6 decimals is 1e15 raw units against a safe
 * ceiling of ~9.007e15. Whole-supply quantities are within one order of
 * magnitude of silently losing integer precision, and a double that overflows
 * that range does not error — it rounds, quietly, in the ledger.
 *
 * So: do the arithmetic in BigInt, convert to a double only for display or for
 * ratios where a few ulp do not matter, and REFUSE rather than round when a
 * conversion cannot be represented. A wrong number that throws is a bug report;
 * a wrong number that does not is a bad fill.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Largest SOL amount convertible to lamports without losing integer precision. */
export const MAX_SAFE_SOL = Number.MAX_SAFE_INTEGER / 1e9;

/** Round half away from zero. Math.round is half-UP, so it is asymmetric on negatives. */
function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * SOL (double) -> lamports (exact integer).
 *
 * Throws on a non-finite input or one too large to represent, rather than
 * returning a quietly wrong integer.
 */
export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol)) throw new RangeError(`solToLamports: ${sol} is not finite`);
  if (Math.abs(sol) > MAX_SAFE_SOL) {
    throw new RangeError(`solToLamports: ${sol} SOL exceeds exact range (${MAX_SAFE_SOL})`);
  }
  return BigInt(roundHalfAwayFromZero(sol * 1e9));
}

/** Lamports -> SOL. Exact for every realistic balance; a double beyond 2^53 rounds. */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be an integer in 0..18, got ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

/**
 * A UI token amount (double) -> raw units (exact integer).
 *
 * Anything below one raw unit is DUST and becomes 0 — that is the chain's own
 * behaviour, and rounding it up would invent tokens that do not exist.
 */
export function tokensToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) throw new RangeError(`tokensToRaw: ${amount} is not finite`);
  const scale = Number(pow10(decimals));
  const scaled = amount * scale;
  if (Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`tokensToRaw: ${amount} at ${decimals} decimals exceeds exact range`);
  }
  return BigInt(roundHalfAwayFromZero(scaled));
}

/** Raw units -> UI amount. Lossy above 2^53 raw units; use rawToDecimalString to be exact. */
export function rawToTokens(raw: bigint, decimals: number): number {
  return Number(raw) / Number(pow10(decimals));
}

/**
 * Raw units -> an EXACT decimal string, for ledgers and reports where a double
 * would round. No exponent notation, no lost digits, at any magnitude.
 */
export function rawToDecimalString(raw: bigint, decimals: number): string {
  const scale = pow10(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / scale;
  const frac = abs % scale;
  const sign = negative ? "-" : "";
  if (decimals === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(decimals, "0")}`;
}

/** Sum lamports exactly. A fold over doubles accumulates error; this cannot. */
export function sumLamports(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/**
 * Apply a bps fee to an integer amount, rounding the FEE up.
 *
 * Rounding the fee up (and so the proceeds down) is the conservative direction:
 * a paper engine that rounds fees down reports an edge the venue never left on
 * the table. The error is at most one lamport per leg, always against us.
 */
export function applyBpsExact(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`bps must be a non-negative integer, got ${bps}`);
  if (amount <= 0n) return 0n;
  const numerator = amount * BigInt(bps);
  const q = numerator / 10_000n;
  return numerator % 10_000n === 0n ? q : q + 1n;
}
