"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { fetchDedupe } from "@/lib/ui/fetch-dedupe";
import { readSelectedVSol } from "@/lib/ui/store";

type LivePrice = {
  vSol: number | null;
  symbol: string | null;
  usdMarketCap: number | null;
};

const Ctx = createContext<LivePrice | null>(null);

/** One shared price poll per selected mint (terminal + quick trade bar). */
export function MintLivePriceProvider({ mint, children }: { mint: string; children: ReactNode }) {
  const [price, setPrice] = useState<LivePrice>(() => ({
    vSol: readSelectedVSol(),
    symbol: null,
    usdMarketCap: null,
  }));

  const tick = useCallback(async () => {
    try {
      const r = await fetchDedupe(`/api/pump/coins/${mint}`);
      if (!r.ok) return;
      const j = (await r.json()) as {
        vSol?: number | null;
        symbol?: string | null;
        usdMarketCap?: number | null;
      };
      setPrice({
        vSol: j.vSol ?? null,
        symbol: j.symbol ?? null,
        usdMarketCap: j.usdMarketCap ?? null,
      });
    } catch {
      /* ignore */
    }
  }, [mint]);

  useEffect(() => {
    setPrice({ vSol: readSelectedVSol(), symbol: null, usdMarketCap: null });
    void tick();
  }, [mint, tick]);

  useVisibleInterval(tick, 3_000, [tick]);

  return <Ctx.Provider value={price}>{children}</Ctx.Provider>;
}

export function useMintLivePrice(): LivePrice | null {
  return useContext(Ctx);
}
