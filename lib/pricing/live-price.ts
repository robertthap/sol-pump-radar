import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/log";
import { rpcCall } from "@/lib/rpc/json-rpc";
import { BoundedMap } from "@/lib/shared/bounded-map";
import { resolveDexPool } from "@/lib/dex/dex-pool";
import {
  bondingCurveAddress,
  canonicalPumpSwapPoolAddress,
  curveEffectiveVSol,
  decodeBondingCurve,
  decodePool,
  decodePoolVaults,
  decodeTokenAccountAmount,
  effectiveVSolFromPriceSol,
  isSolQuotedCurve,
  poolPriceSol,
  type PoolVaults,
} from "@/lib/pump/onchain-accounts";
import { PUMP_BONDING_CURVE_PROGRAM, PUMP_SWAP_AMM_PROGRAM } from "@/lib/pump/program";

/**
 * Live price for a pump.fun coin, read from the chain (the single price source for
 * paper fills, exit decisions, bookings and mark-to-market).
 *
 *   curve      bonding curve not complete → its virtual SOL reserves, the same
 *              basis as events.v_sol_after.
 *   graduated  curve complete → the PumpSwap pool's spot price (SOL vault / token
 *              vault) as an effective vSol on the curve scale. No SOL/USD rate and
 *              no third-party API is involved, so P&L on this basis is exact in SOL.
 *   unknown    the price could not be established; `reason` says why. Callers treat
 *              this as "no price", never as a cue to use a different source.
 *
 * Replaces pricing that mixed the pump.fun API's market cap, a DexScreener pool
 * lookup and the frozen curve price, and whose fallbacks booked a flat coin at -101%.
 */
export type LivePrice =
  | { phase: "curve"; vSol: number; at: number }
  | { phase: "graduated"; vSol: number; priceSol: number; pool: string; at: number }
  | { phase: "unknown"; reason: string; at: number };

const log = logger("live-price");

/** Freshness window. Exit ticks run every 3 s; this dedupes callers within a tick. */
const PRICE_TTL_MS = 2_000;
/** After failing to find a pool, wait this long before looking again. */
const NO_POOL_RETRY_MS = 60_000;
/** getMultipleAccounts accepts at most 100 keys. */
const RPC_BATCH = 100;

const priceCache = new BoundedMap<string, LivePrice>(5_000);
/** Pools and their vaults never change once created. */
const vaultsByMint = new BoundedMap<string, { pool: string; vaults: PoolVaults }>(20_000);
const noPoolUntil = new BoundedMap<string, number>(5_000);
let lastRpcWarnAt = 0;

/**
 * Account data per key, or null when RPC failed. An entry is null when the account
 * does not exist or is not owned by `owner` (when given), so a stray account at a
 * derived address can never be decoded as if it were the real thing.
 */
type AccountRead = { data: Buffer; lamports: number };

async function readAccounts(keys: string[], owner?: string): Promise<(AccountRead | null)[] | null> {
  const out: (AccountRead | null)[] = [];
  for (let i = 0; i < keys.length; i += RPC_BATCH) {
    const chunk = keys.slice(i, i + RPC_BATCH);
    const res = await rpcCall<{ value: Array<{ data: [string, string]; owner: string; lamports: number } | null> }>(
      "getMultipleAccounts",
      [chunk, { encoding: "base64", commitment: "processed" }],
    );
    if (!res || !Array.isArray(res.value) || res.value.length !== chunk.length) {
      if (Date.now() - lastRpcWarnAt > 60_000) {
        lastRpcWarnAt = Date.now();
        log.warn("getMultipleAccounts failed on every RPC endpoint", { keys: chunk.length });
      }
      return null;
    }
    for (const acc of res.value) {
      out.push(
        acc && (!owner || acc.owner === owner)
          ? { data: Buffer.from(acc.data[0], "base64"), lamports: acc.lamports }
          : null,
      );
    }
  }
  return out;
}

async function getAccounts(keys: string[], owner?: string): Promise<(Buffer | null)[] | null> {
  const reads = await readAccounts(keys, owner);
  return reads ? reads.map((r) => r?.data ?? null) : null;
}

async function registryPool(mint: string): Promise<string | null> {
  try {
    const res = await getDb().execute(sql`
      SELECT pair_address FROM pool_registry
      WHERE mint = ${mint} AND dex_id = 'pumpswap'
      ORDER BY liq_usd DESC NULLS LAST
      LIMIT 1
    `);
    return (res as unknown as { rows: Array<{ pair_address: string | null }> }).rows[0]?.pair_address ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the vaults of a graduated coin's pool: the canonical migration pool first
 * (derived, no API), then pool_registry, then DexScreener. Results are cached for
 * good; a miss is retried after NO_POOL_RETRY_MS.
 */
async function resolveVaults(mints: string[]): Promise<void> {
  const now = Date.now();
  const todo = mints.filter((m) => !vaultsByMint.has(m) && (noPoolUntil.get(m) ?? 0) <= now);
  if (todo.length === 0) return;

  const canonical = todo.map(canonicalPumpSwapPoolAddress);
  const bufs = await getAccounts(canonical, PUMP_SWAP_AMM_PROGRAM);
  if (!bufs) return; // RPC down: leave uncached so the next tick retries
  const fallback: string[] = [];
  todo.forEach((mint, i) => {
    const vaults = bufs[i] ? decodePoolVaults(bufs[i]!, mint) : null;
    if (vaults) vaultsByMint.set(mint, { pool: canonical[i]!, vaults });
    else fallback.push(mint);
  });

  for (const mint of fallback) {
    const candidates = [await registryPool(mint), await resolveDexPool(mint).catch(() => null)];
    let found = false;
    for (const pool of new Set(candidates.filter((p): p is string => !!p))) {
      const acc = await getAccounts([pool], PUMP_SWAP_AMM_PROGRAM);
      if (!acc) return;
      const vaults = acc[0] ? decodePoolVaults(acc[0], mint) : null;
      if (vaults) {
        vaultsByMint.set(mint, { pool, vaults });
        found = true;
        break;
      }
    }
    if (!found) noPoolUntil.set(mint, now + NO_POOL_RETRY_MS);
  }
}

export async function fetchLivePrices(mints: string[]): Promise<Map<string, LivePrice>> {
  const now = Date.now();
  const out = new Map<string, LivePrice>();
  const need: string[] = [];
  for (const mint of new Set(mints)) {
    const cached = priceCache.get(mint);
    if (cached && now - cached.at < PRICE_TTL_MS) out.set(mint, cached);
    else need.push(mint);
  }
  if (need.length === 0) return out;

  const put = (mint: string, p: LivePrice) => {
    out.set(mint, p);
    priceCache.set(mint, p);
  };

  let curveKeys: string[];
  try {
    curveKeys = need.map(bondingCurveAddress);
  } catch {
    for (const mint of need) put(mint, { phase: "unknown", reason: "not a valid mint address", at: now });
    return out;
  }
  const curves = await readAccounts(curveKeys, PUMP_BONDING_CURVE_PROGRAM);
  if (!curves) {
    // Not cached: a failed read should not pin "unknown" for the TTL.
    for (const mint of need) out.set(mint, { phase: "unknown", reason: "RPC unavailable", at: now });
    return out;
  }

  const graduated: string[] = [];
  need.forEach((mint, i) => {
    const acc = curves[i];
    if (!acc) return put(mint, { phase: "unknown", reason: "no bonding-curve account (not a pump.fun coin)", at: now });
    const state = decodeBondingCurve(acc.data);
    if (!state) return put(mint, { phase: "unknown", reason: "unreadable bonding-curve account", at: now });
    if (state.complete) return void graduated.push(mint);
    // A curve quoted in another asset reports its reserves in that asset's units;
    // reading them as SOL would invent a price.
    if (!isSolQuotedCurve(acc.lamports, state.realSolReserves)) {
      return put(mint, { phase: "unknown", reason: "bonding curve is not quoted in SOL", at: now });
    }
    // Price-based, so a non-standard curve (Mayhem mode) lands on the same scale
    // as the standard curve and as the pool price after graduation.
    const vSol = curveEffectiveVSol(state);
    if (vSol != null) return put(mint, { phase: "curve", vSol, at: now });
    put(mint, { phase: "unknown", reason: "bonding curve has no reserves", at: now });
  });
  if (graduated.length === 0) return out;

  await resolveVaults(graduated);
  const priced = graduated.filter((m) => vaultsByMint.has(m));
  for (const mint of graduated) {
    if (!vaultsByMint.has(mint)) {
      out.set(mint, { phase: "unknown", reason: "graduated but no SOL-quoted PumpSwap pool found", at: now });
    }
  }
  if (priced.length === 0) return out;

  // Per coin: the pool account (for its virtual SOL reserve) and its two vaults.
  const keys = priced.flatMap((m) => {
    const { pool, vaults } = vaultsByMint.get(m)!;
    return [pool, vaults.memeVault, vaults.solVault];
  });
  const accounts = await getAccounts(keys);
  priced.forEach((mint, i) => {
    if (!accounts) {
      out.set(mint, { phase: "unknown", reason: "RPC unavailable", at: now });
      return;
    }
    const poolBuf = accounts[3 * i];
    const memeBuf = accounts[3 * i + 1];
    const solBuf = accounts[3 * i + 2];
    const poolState = poolBuf ? decodePool(poolBuf, mint) : null;
    if (!poolState) {
      put(mint, { phase: "unknown", reason: "PumpSwap pool account unreadable or of an unknown layout", at: now });
      return;
    }
    const meme = memeBuf ? decodeTokenAccountAmount(memeBuf) : null;
    const sol = solBuf ? decodeTokenAccountAmount(solBuf) : null;
    // Newer pools price with a virtual SOL reserve on top of the SOL vault.
    const priceSol = meme != null && sol != null ? poolPriceSol(sol + poolState.virtualQuoteLamports, meme) : null;
    const vSol = priceSol != null ? effectiveVSolFromPriceSol(priceSol) : null;
    if (priceSol == null || vSol == null) {
      put(mint, { phase: "unknown", reason: "PumpSwap pool has no reserves", at: now });
      return;
    }
    put(mint, { phase: "graduated", vSol, priceSol, pool: vaultsByMint.get(mint)!.pool, at: now });
  });
  return out;
}

export async function fetchLivePrice(mint: string): Promise<LivePrice> {
  const res = await fetchLivePrices([mint]);
  return res.get(mint) ?? { phase: "unknown", reason: "not resolved", at: Date.now() };
}
