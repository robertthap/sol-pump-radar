"use client";

import { useCallback, useEffect, useState } from "react";
import { SOL_USD_FALLBACK, SOL_AUD_FALLBACK } from "@/lib/market/sol-usd";

export type SolPrice = {
  usd: number;
  aud: number;
  /** M01: the rate was fetched but is old. The number is real, just not current. */
  stale: boolean;
  /** M01: never fetched in this process — the number is a hardcoded guess. */
  fallback: boolean;
};

/** Live SOL price in USD + AUD (polls /api/market/sol-usd). */
export function useSolPrice(pollMs = 60_000): SolPrice {
  // Starts as the fallback and SAYS so, rather than claiming A$230 is a rate.
  const [price, setPrice] = useState<SolPrice>({
    usd: SOL_USD_FALLBACK, aud: SOL_AUD_FALLBACK, stale: true, fallback: true,
  });

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/market/sol-usd", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { usd?: number; aud?: number; stale?: boolean; fallback?: boolean };
      setPrice((prev) => ({
        usd: j.usd != null && Number.isFinite(j.usd) && j.usd > 0 ? j.usd : prev.usd,
        aud: j.aud != null && Number.isFinite(j.aud) && j.aud > 0 ? j.aud : prev.aud,
        // Absent flags mean an older server that cannot vouch for the rate.
        stale: j.stale ?? true,
        fallback: j.fallback ?? true,
      }));
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(id);
  }, [load, pollMs]);

  return price;
}

/** @deprecated Use useSolPrice().usd. Kept for back-compat. */
export function useSolUsd(pollMs = 60_000): number {
  return useSolPrice(pollMs).usd;
}

/**
 * Approx AUD value of a SOL amount, e.g. "≈ A$1,040" (M01).
 *
 * A never-fetched rate is a hardcoded guess, so converting with it produces a
 * number with no meaning — say the rate is unavailable instead of printing
 * fiction. A merely STALE rate was real once, so show it and mark it.
 */
export function solToAudDisplay(
  sol: number,
  solAud: number,
  freshness?: { stale?: boolean; fallback?: boolean },
): string {
  if (freshness?.fallback) return "A$ rate unavailable";
  const value = `≈ A$${Math.round(sol * solAud).toLocaleString()}`;
  return freshness?.stale ? `${value} (stale rate)` : value;
}

/** @deprecated Use solToAudDisplay — the app shows fiat in AUD. */
export function solToUsdDisplay(sol: number, solUsd: number): string {
  return `≈ $${Math.round(sol * solUsd).toLocaleString()}`;
}
