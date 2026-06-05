"use client";

import { useCallback, useEffect, useState } from "react";
import { SOL_USD_FALLBACK, SOL_AUD_FALLBACK } from "@/lib/market/sol-usd";

export type SolPrice = { usd: number; aud: number };

/** Live SOL price in USD + AUD (polls /api/market/sol-usd). */
export function useSolPrice(pollMs = 60_000): SolPrice {
  const [price, setPrice] = useState<SolPrice>({ usd: SOL_USD_FALLBACK, aud: SOL_AUD_FALLBACK });

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/market/sol-usd", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { usd?: number; aud?: number };
      setPrice((prev) => ({
        usd: j.usd != null && Number.isFinite(j.usd) && j.usd > 0 ? j.usd : prev.usd,
        aud: j.aud != null && Number.isFinite(j.aud) && j.aud > 0 ? j.aud : prev.aud,
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

/** Approx AUD value of a SOL amount, e.g. "≈ A$1,040". */
export function solToAudDisplay(sol: number, solAud: number): string {
  return `≈ A$${Math.round(sol * solAud).toLocaleString()}`;
}

/** @deprecated Use solToAudDisplay — the app shows fiat in AUD. */
export function solToUsdDisplay(sol: number, solUsd: number): string {
  return `≈ $${Math.round(sol * solUsd).toLocaleString()}`;
}
