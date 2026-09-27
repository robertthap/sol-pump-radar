/**
 * On-chain pump.fun / PumpSwap account addressing and decoding (PURE — no IO).
 *
 * These are the primitives behind live pricing (lib/pricing/live-price.ts): read
 * the bonding-curve account to learn whether a coin has graduated and, if not,
 * its exact virtual SOL reserves; after graduation read the PumpSwap pool's two
 * vaults and turn the spot price into an "effective vSol" on the same scale.
 *
 * Everything here is verified against live data rather than assumed:
 *   - canonicalPumpSwapPoolAddress matched 7 of 8 PumpSwap pairs in pool_registry
 *     (the eighth is a second, non-canonical pool DexScreener ranked first), and
 *     the account layouts are checked against real accounts in the tests' fixtures.
 */
import { PublicKey } from "@solana/web3.js";
import {
  PUMP_BONDING_CURVE_PROGRAM,
  PUMP_SWAP_AMM_PROGRAM,
  PUMP_SUPPLY,
  PUMP_TOKEN_DECIMALS,
  SOL_DECIMALS,
  WSOL_MINT,
} from "@/lib/pump/program";
import { CURVE_DIV } from "@/lib/dex/curve-mcap";

const PUMP_PROGRAM_KEY = new PublicKey(PUMP_BONDING_CURVE_PROGRAM);
const PUMP_AMM_KEY = new PublicKey(PUMP_SWAP_AMM_PROGRAM);
const WSOL_KEY = new PublicKey(WSOL_MINT);

/** Bonding-curve PDA: seeds ["bonding-curve", mint] under the pump.fun program. */
export function bondingCurveAddress(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM_KEY,
  );
  return pda.toBase58();
}

/**
 * The PumpSwap pool pump.fun migrates a coin into: seeds
 * ["pool", index u16 LE = 0, pool-authority PDA, mint, WSOL] under the AMM program,
 * where pool-authority = ["pool-authority", mint] under the pump.fun program.
 */
export function canonicalPumpSwapPoolAddress(mint: string): string {
  const mintKey = new PublicKey(mint);
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mintKey.toBuffer()],
    PUMP_PROGRAM_KEY,
  );
  const index = Buffer.alloc(2);
  index.writeUInt16LE(0);
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), index, authority.toBuffer(), mintKey.toBuffer(), WSOL_KEY.toBuffer()],
    PUMP_AMM_KEY,
  );
  return pool.toBase58();
}

export type BondingCurveState = {
  /** Virtual SOL reserves in whole SOL — the same basis as events.v_sol_after. */
  virtualSolReserves: number;
  /** Virtual token reserves in whole tokens. */
  virtualTokenReserves: number;
  /** Real reserve of the quote asset, read as SOL (only meaningful when the curve IS SOL-quoted). */
  realSolReserves: number;
  /** True once the curve has completed (the coin has graduated). */
  complete: boolean;
};

/**
 * Whether a bonding curve is actually quoted in SOL. A SOL-quoted curve holds its
 * real SOL reserve as lamports in the curve account itself (plus rent), so the
 * account balance covers the real-reserve field. Curves quoted in another asset
 * report 0 SOL traded in their events and hold only rent while that field reads up
 * to tens of units; pricing them as SOL would be meaningless.
 * Checked 2026-09-13: 8 SOL-quoted curves (standard and Mayhem) matched to within
 * the rent term; 6 curves whose events carry no SOL price held none of it.
 */
export function isSolQuotedCurve(accountLamports: number, realSolReserves: number): boolean {
  const heldSol = accountLamports / 1e9;
  // Held SOL = real reserve + rent (a few thousandths); allow a little dust on top.
  return heldSol + 1e-6 >= realSolReserves && heldSol - realSolReserves <= 0.05;
}

/**
 * Bonding-curve account: 8-byte discriminator, then u64 virtual_token_reserves,
 * u64 virtual_sol_reserves, u64 real_token_reserves, u64 real_sol_reserves,
 * u64 token_total_supply, bool complete (offset 48). Later fields are ignored.
 */
export function decodeBondingCurve(data: Buffer): BondingCurveState | null {
  if (data.length < 49) return null;
  const vTok = data.readBigUInt64LE(8);
  const vSol = data.readBigUInt64LE(16);
  const realSol = data.readBigUInt64LE(32);
  const completeByte = data.readUInt8(48);
  if (completeByte > 1) return null;
  return {
    virtualTokenReserves: Number(vTok) / 10 ** PUMP_TOKEN_DECIMALS,
    virtualSolReserves: Number(vSol) / 10 ** SOL_DECIMALS,
    realSolReserves: Number(realSol) / 10 ** SOL_DECIMALS,
    complete: completeByte === 1,
  };
}

/**
 * Curve-equivalent vSol of a bonding curve: from its spot price (virtual SOL /
 * virtual tokens), not the raw SOL reserve. Equal to the raw reserve on the
 * standard curve; on a curve with a different constant (Mayhem-mode coins start
 * near 0 virtual SOL) the raw reserve is on another scale and would break the
 * market-cap formula and the price basis at graduation.
 */
export function curveEffectiveVSol(state: BondingCurveState): number | null {
  if (!(state.virtualSolReserves > 0) || !(state.virtualTokenReserves > 0)) return null;
  return effectiveVSolFromPriceSol(state.virtualSolReserves / state.virtualTokenReserves);
}

export type PoolVaults = { memeVault: string; solVault: string };

/**
 * PumpSwap pool account (after the 8-byte discriminator): base_mint @43,
 * quote_mint @75, base vault @139, quote vault @171. Returns the vaults only when
 * one side is `mint` and the other WSOL, so a wrong or foreign pool is rejected.
 */
export function decodePoolVaults(data: Buffer, mint: string): PoolVaults | null {
  if (data.length < 203) return null;
  const pk = (off: number) => new PublicKey(data.subarray(off, off + 32)).toBase58();
  const baseMint = pk(43);
  const quoteMint = pk(75);
  const baseVault = pk(139);
  const quoteVault = pk(171);
  if (baseMint === mint && quoteMint === WSOL_MINT) return { memeVault: baseVault, solVault: quoteVault };
  if (quoteMint === mint && baseMint === WSOL_MINT) return { memeVault: quoteVault, solVault: baseVault };
  return null;
}

export type PoolState = PoolVaults & {
  /**
   * Virtual SOL the pool adds to its SOL vault when pricing. Newer PumpSwap pools
   * carry one (17.58 SOL on the pools checked); older pools have 0. Ignoring it
   * under-priced those pools by 1.5x at normal liquidity and ~9x after a dump.
   */
  virtualQuoteLamports: bigint;
};

/** Offset of the virtual quote (SOL) reserve in PumpSwap pool accounts (0 on older pools). */
export const POOL_VIRTUAL_QUOTE_OFFSET = 245;
/** A value above this cannot be a real virtual reserve: the layout is not the one we know. */
const MAX_VIRTUAL_QUOTE_LAMPORTS = 1_000n * 1_000_000_000n;

/**
 * Vaults plus the virtual SOL reserve. Verified 2026-09-13 against real swaps: on
 * a pool with 17.5845 virtual SOL, a sell's execution price (1.5754e-7) sat between
 * (SOL vault + virtual) / token vault before (1.6088e-7) and after (1.5430e-7) the
 * trade, as a constant-product swap must; with the raw vaults alone it did not.
 * Returns null for a layout it cannot trust, so the coin is unpriced, not mispriced.
 */
export function decodePool(data: Buffer, mint: string): PoolState | null {
  const vaults = decodePoolVaults(data, mint);
  if (!vaults) return null;
  if (data.length < POOL_VIRTUAL_QUOTE_OFFSET + 8) return { ...vaults, virtualQuoteLamports: 0n };
  const virtualQuoteLamports = data.readBigUInt64LE(POOL_VIRTUAL_QUOTE_OFFSET);
  if (virtualQuoteLamports > MAX_VIRTUAL_QUOTE_LAMPORTS) return null;
  // The virtual reserve is on the quote side. Only the canonical orientation
  // (base = coin, quote = WSOL) is known to use it; a reversed pool that carries
  // one has semantics we have not verified.
  const quoteIsWsol = new PublicKey(data.subarray(75, 107)).toBase58() === WSOL_MINT;
  if (!quoteIsWsol && virtualQuoteLamports > 0n) return null;
  return { ...vaults, virtualQuoteLamports };
}

/** SPL token account amount: u64 at offset 64 (same for Token and Token-2022). */
export function decodeTokenAccountAmount(data: Buffer): bigint | null {
  if (data.length < 72) return null;
  return data.readBigUInt64LE(64);
}

/** Pool spot price in SOL per whole token, or null when either reserve is empty. */
export function poolPriceSol(solVaultRaw: bigint, memeVaultRaw: bigint): number | null {
  if (solVaultRaw <= 0n || memeVaultRaw <= 0n) return null;
  const sol = Number(solVaultRaw) / 10 ** SOL_DECIMALS;
  const tokens = Number(memeVaultRaw) / 10 ** PUMP_TOKEN_DECIMALS;
  const price = sol / tokens;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * The vSol the standard curve would need to quote this spot price. On the curve
 * price = vSol / vTokens and vSol · vTokens = k, so price = vSol² / k with
 * k = CURVE_DIV · supply. No SOL/USD rate is involved, so P&L computed on this
 * basis is exact in SOL.
 */
export function effectiveVSolFromPriceSol(priceSol: number): number | null {
  if (!Number.isFinite(priceSol) || priceSol <= 0) return null;
  return Math.sqrt(priceSol * CURVE_DIV * PUMP_SUPPLY);
}
