import "server-only";

import type { TrenchCoin } from "@/components/TrenchCoinCard";

type GmgnToken = {
  address?: string;
  symbol?: string;
  name?: string;
  logo?: string;
  open_timestamp?: number;
  market_cap?: number;
  swaps?: number;
  twitter?: string;
  telegram?: string;
  website?: string;
};

type GmgnResponse = {
  code?: number;
  data?: { rank?: GmgnToken[] };
};

/** Best-effort GMGN rank fetch — often blocked by Cloudflare from server IPs. */
export async function tryFetchGmgnRank(
  orderBy: "open_timestamp" | "swaps" | "volume" | "marketcap",
  period: "1h" | "6h" | "24h" = "1h",
  limit = 20,
): Promise<TrenchCoin[]> {
  const q = new URLSearchParams({
    orderby: orderBy,
    direction: "desc",
  });
  q.append("filters[]", "not_honeypot");

  const url = `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/${period}?${q}`;

  try {
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      next: { revalidate: 0 },
    });
    const text = await r.text();
    if (!text.startsWith("{")) return [];
    const j = JSON.parse(text) as GmgnResponse;
    if (j.code !== 0 || !j.data?.rank?.length) return [];

    return j.data.rank
      .slice(0, limit)
      .map((t) => ({
        mint: t.address ?? "",
        name: t.name ?? null,
        symbol: t.symbol ?? null,
        complete: false,
        vSol: null,
        usdMarketCap: t.market_cap ?? null,
        createdAt: t.open_timestamp ? new Date(t.open_timestamp * 1000).toISOString() : null,
        lastTradeAt: null,
        imageUri: t.logo ?? null,
        twitter: t.twitter ?? null,
        telegram: t.telegram ?? null,
        website: t.website ?? null,
        creator: null,
        replyCount: t.swaps ?? 0,
        bondingPct: null,
      }))
      .filter((c) => c.mint.length > 20);
  } catch {
    return [];
  }
}
