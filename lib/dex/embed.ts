export type DexEmbedProvider = "dexscreener";

export type DexEmbedConfig = {
  provider: DexEmbedProvider;
  embedUrl: string;
  externalUrl: string;
  pairAddress: string;
  dexId: string | null;
  symbol: string | null;
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
};

const WSOL = "So11111111111111111111111111111111111111112";

export function dexscreenerEmbedUrl(
  pairAddress: string,
  opts?: { theme?: "light" | "dark"; info?: boolean; trades?: boolean },
): string {
  const theme = opts?.theme ?? "light";
  const q = new URLSearchParams({
    embed: "1",
    info: opts?.info === false ? "0" : "1",
    trades: opts?.trades === false ? "0" : "1",
    tabs: "0",
    chartLeftToolbar: "0",
    chartTheme: theme,
    theme,
  });
  return `https://dexscreener.com/solana/${pairAddress}?${q}`;
}

function pickBestPair(pairs: DexPair[], mint: string): DexPair | null {
  const solana = pairs.filter((p) => p.chainId === "solana" && p.pairAddress);
  if (!solana.length) return null;

  const scored = solana
    .map((p) => {
      const liq = p.liquidity?.usd ?? 0;
      const pumpBonus = /pump/i.test(p.dexId ?? "") ? 50_000 : 0;
      const baseHit = p.baseToken?.address === mint ? 10_000 : 0;
      return { p, score: liq + pumpBonus + baseHit };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.p ?? null;
}

/** Resolve DexScreener embed for a mint, or null if no pair is listed yet. */
export async function resolveDexEmbed(mint: string): Promise<DexEmbedConfig | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      next: { revalidate: 60 },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { pairs?: DexPair[] };
    const pair = pickBestPair(j.pairs ?? [], mint);
    if (!pair?.pairAddress) return null;

    const symbol =
      pair.baseToken?.address === mint ? pair.baseToken.symbol : pair.quoteToken?.symbol;

    return {
      provider: "dexscreener",
      embedUrl: dexscreenerEmbedUrl(pair.pairAddress, { info: true, trades: true }),
      externalUrl: `https://dexscreener.com/solana/${pair.pairAddress}`,
      pairAddress: pair.pairAddress,
      dexId: pair.dexId ?? null,
      symbol: symbol ?? null,
    };
  } catch {
    return null;
  }
}

export function tokenSymbolFromPair(pair: DexPair, mint: string): string | null {
  if (pair.baseToken?.address === mint) return pair.baseToken.symbol ?? null;
  if (pair.quoteToken?.address === mint) return pair.quoteToken.symbol ?? null;
  return pair.baseToken?.symbol ?? null;
}

export { WSOL };
