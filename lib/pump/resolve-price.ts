import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { sqlTimestamptz } from "@/lib/db/sql-timestamp";
import { fetchPumpFunCoin, pumpFunVSol, type PumpFunCoinRaw } from "@/lib/pump/fun-api";

export async function resolveMintVSol(mint: string): Promise<number | null> {
  const res = await getDb().execute(sql`
    SELECT v_sol_after::float8 AS v FROM events
    WHERE mint = ${mint} AND v_sol_after IS NOT NULL
    ORDER BY ts DESC LIMIT 1
  `);
  const local = (res as unknown as { rows: Array<{ v: number | null }> }).rows[0]?.v ?? null;
  if (local != null && local > 0) return local;

  const feat = await getDb().execute(sql`
    SELECT v_sol::float8 AS v FROM token_features
    WHERE mint = ${mint} AND v_sol IS NOT NULL AND v_sol > 0
    ORDER BY ts DESC
    LIMIT 1
  `);
  const fromFeat = (feat as unknown as { rows: Array<{ v: number | null }> }).rows[0]?.v ?? null;
  if (fromFeat != null && fromFeat > 0) return fromFeat;

  try {
    const coin = await fetchPumpFunCoin(mint);
    if (!coin?.vSol || coin.vSol <= 0) return null;
    return coin.vSol;
  } catch {
    return null;
  }
}

/** Price for opening a position: latest curve, signal-time event, features, then pump.fun. */
export async function resolveEntryVSol(
  mint: string,
  opts?: { decisionTs?: string | Date; hintVSol?: number | null },
): Promise<number | null> {
  if (opts?.hintVSol != null && opts.hintVSol > 0) return opts.hintVSol;

  const latest = await resolveMintVSol(mint);
  if (latest != null && latest > 0) return latest;

  if (opts?.decisionTs != null) {
    const decisionAt =
      opts.decisionTs instanceof Date ? opts.decisionTs : new Date(opts.decisionTs);
    if (!Number.isFinite(decisionAt.getTime())) {
      return null;
    }
    const signalWindowEnd = new Date(decisionAt.getTime() + 30_000);
    const atSignal = await getDb().execute(sql`
      SELECT e.v_sol_after::float8 AS v
      FROM events e
      WHERE e.mint = ${mint}
        AND e.v_sol_after IS NOT NULL
        AND e.v_sol_after > 0
        AND e.ts <= ${sqlTimestamptz(signalWindowEnd)}
      ORDER BY e.ts DESC
      LIMIT 1
    `);
    const v = (atSignal as unknown as { rows: Array<{ v: number | null }> }).rows[0]?.v ?? null;
    if (v != null && v > 0) return v;
  }

  try {
    const coin = await fetchPumpFunCoin(mint);
    if (coin?.vSol != null && coin.vSol > 0) return coin.vSol;
  } catch {
    /* network / non-pump mint */
  }

  return null;
}

/** Validate pump.fun mint and resolve vSol — client hint skips network/DB for speed. */
export async function resolvePumpTradeMint(
  mint: string,
  hintVSol?: number | null,
): Promise<{ ok: true; vSol: number } | { ok: false; error: string }> {
  if (hintVSol != null && hintVSol > 0) {
    return { ok: true, vSol: hintVSol };
  }

  const local = await resolveMintVSol(mint);
  if (local != null && local > 0) {
    return { ok: true, vSol: local };
  }

  try {
    const coin = await fetchPumpFunCoin(mint);
    if (!coin) return { ok: false, error: "not_a_pump_fun_coin" };
    if (coin.vSol != null && coin.vSol > 0) return { ok: true, vSol: coin.vSol };
    return { ok: false, error: "no_price" };
  } catch {
    return { ok: false, error: "pump_fun_lookup_failed" };
  }
}

export async function ensurePumpFunMint(mint: string): Promise<{ ok: true; vSol: number | null } | { ok: false; error: string }> {
  try {
    const coin = await fetchPumpFunCoin(mint);
    if (!coin) return { ok: false, error: "not_a_pump_fun_coin" };
    return { ok: true, vSol: coin.vSol };
  } catch {
    return { ok: false, error: "pump_fun_lookup_failed" };
  }
}

/** Raw vSol from pump.fun response without full validation. */
export function vSolFromRaw(raw: PumpFunCoinRaw): number | null {
  return pumpFunVSol(raw);
}
