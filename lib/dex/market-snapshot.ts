import "server-only";

export type DexPairRaw = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  liquidity?: { usd?: number };
};

export type DexMarketSnapshot = {
  mint: string;
  symbol: string | null;
  name: string | null;
  primaryPool: string;
  primaryDex: string | null;
  poolCount: number;
  pools: Array<{ pairAddress: string; dexId: string | null; liqUsd: number; priceUsd: number | null }>;
  volM5: number;
  volH1: number;
  volH24: number;
  volAcceleration: number;
  liqUsd: number;
  buysM5: number;
  sellsM5: number;
  buySellRatio: number;
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH24: number | null;
  pairCreatedAt: Date | null;
  migrationAgeHours: number | null;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickPrimaryPair(pairs: DexPairRaw[], mint: string): DexPairRaw | null {
  const solana = pairs.filter((p) => p.chainId === "solana" && p.pairAddress);
  if (!solana.length) return null;
  const scored = solana
    .map((p) => {
      const liq = p.liquidity?.usd ?? 0;
      const pumpBonus = /pump/i.test(p.dexId ?? "") ? 20_000 : 0;
      const baseHit = p.baseToken?.address === mint ? 5_000 : 0;
      return { p, score: liq + pumpBonus + baseHit };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.p ?? null;
}

function aggregatePairs(pairs: DexPairRaw[], mint: string): DexMarketSnapshot | null {
  const primary = pickPrimaryPair(pairs, mint);
  if (!primary?.pairAddress) return null;

  const solana = pairs.filter((p) => p.chainId === "solana" && p.pairAddress);
  let volM5 = 0;
  let volH1 = 0;
  let volH24 = 0;
  let buysM5 = 0;
  let sellsM5 = 0;
  let liqUsd = 0;

  for (const p of solana) {
    if (p.baseToken?.address !== mint && p.quoteToken?.address !== mint) continue;
    volM5 += num(p.volume?.m5);
    volH1 += num(p.volume?.h1);
    volH24 += num(p.volume?.h24);
    buysM5 += num(p.txns?.m5?.buys);
    sellsM5 += num(p.txns?.m5?.sells);
    liqUsd = Math.max(liqUsd, num(p.liquidity?.usd));
  }

  const volAcceleration =
    volH1 > 0 ? Math.max(0, (volM5 * 12) / volH1 - 1) : volM5 > 0 ? 1 : 0;

  const pairCreatedAt =
    primary.pairCreatedAt != null ? new Date(primary.pairCreatedAt) : null;
  const migrationAgeHours =
    pairCreatedAt != null
      ? Math.max(0, (Date.now() - pairCreatedAt.getTime()) / 3_600_000)
      : null;

  return {
    mint,
    symbol: primary.baseToken?.address === mint ? primary.baseToken.symbol ?? null : null,
    name: primary.baseToken?.address === mint ? primary.baseToken.name ?? null : null,
    primaryPool: primary.pairAddress,
    primaryDex: primary.dexId ?? null,
    poolCount: solana.filter((p) => p.baseToken?.address === mint).length,
    pools: solana
      .filter((p) => p.baseToken?.address === mint && p.pairAddress)
      .map((p) => ({
        pairAddress: p.pairAddress!,
        dexId: p.dexId ?? null,
        liqUsd: num(p.liquidity?.usd),
        priceUsd: p.priceUsd != null ? num(p.priceUsd) : null,
      })),
    volM5,
    volH1,
    volH24,
    volAcceleration,
    liqUsd,
    buysM5,
    sellsM5,
    buySellRatio: sellsM5 > 0 ? buysM5 / sellsM5 : buysM5 > 0 ? buysM5 : 0,
    priceChangeM5: primary.priceChange?.m5 ?? null,
    priceChangeH1: primary.priceChange?.h1 ?? null,
    priceChangeH24: primary.priceChange?.h24 ?? null,
    pairCreatedAt,
    migrationAgeHours,
  };
}

export async function fetchDexBoostMints(limit = 40): Promise<string[]> {
  try {
    const r = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
      cache: "no-store",
    });
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{ chainId?: string; tokenAddress?: string }>;
    return rows
      .filter((x) => x.chainId === "solana" && x.tokenAddress)
      .map((x) => x.tokenAddress!)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Batch fetch DexScreener market data (comma-separated mints, max ~30 per call). */
export async function fetchDexMarketBatch(mints: string[]): Promise<Map<string, DexMarketSnapshot>> {
  const out = new Map<string, DexMarketSnapshot>();
  const unique = [...new Set(mints.filter(Boolean))];
  const chunkSize = 25;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`,
        { cache: "no-store" },
      );
      if (!r.ok) continue;
      const j = (await r.json()) as { pairs?: DexPairRaw[] };
      const byMint = new Map<string, DexPairRaw[]>();
      for (const p of j.pairs ?? []) {
        const m = p.baseToken?.address;
        if (!m) continue;
        const list = byMint.get(m) ?? [];
        list.push(p);
        byMint.set(m, list);
      }
      for (const mint of chunk) {
        const snap = aggregatePairs(byMint.get(mint) ?? [], mint);
        if (snap) out.set(mint, snap);
      }
    } catch {
      /* next chunk */
    }
  }

  return out;
}
