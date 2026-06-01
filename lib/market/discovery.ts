import "server-only";

import { cached } from "@/lib/api/short-cache";
import { tryFetchGmgnRank } from "@/lib/gmgn/rank";
import { enrichMarketMints } from "@/lib/market/enrich-mints";
import type { MarketCoin, MarketCoinAnalysis, MarketFeed } from "@/lib/market/types";
import { fetchPumpFunCoin, fetchTrenchesFeed, type PumpFunCoin } from "@/lib/pump/fun-api";
import type { TrenchCoin } from "@/components/TrenchCoinCard";

type DexBoost = {
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  icon?: string;
  links?: Array<{ type?: string; url?: string }>;
};

const SCANNING: MarketCoinAnalysis = {
  action: null,
  actionLabel: "Scanning",
  confluenceScore: null,
  gradScore: null,
  rugScore: null,
  qualityScore: 0,
  qualityTier: "weak",
  tradable: false,
  tradeableStatus: "wait",
  tradeableReason: "Waiting for radar scan",
  rugLabel: null,
  hasBundle: false,
  hasSniper: false,
  mechanicalUptrend: false,
  smartMoneyCount: 0,
  tags: [],
  primaryFlag: "scanning",
  flagLabel: "Scanning…",
};

type DiscoverySlice = {
  newBase: TrenchCoin[];
  trendingBase: TrenchCoin[];
  migratedBase: TrenchCoin[];
  allMints: string[];
  sources: MarketFeed["sources"];
};

type EnrichState = {
  key: string;
  at: number;
  data: Map<string, MarketCoinAnalysis>;
  refreshing: boolean;
};

let enrichState: EnrichState = { key: "", at: 0, data: new Map(), refreshing: false };

function mintCacheKey(mints: string[]): string {
  return [...new Set(mints)].sort().join("|");
}

function pumpToTrench(c: PumpFunCoin): TrenchCoin {
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    complete: c.complete,
    vSol: c.vSol,
    usdMarketCap: c.usdMarketCap,
    createdAt: c.createdAt,
    lastTradeAt: c.lastTradeAt,
    imageUri: c.imageUri,
    twitter: c.twitter,
    telegram: c.telegram,
    website: c.website,
    creator: c.creator,
    replyCount: c.replyCount,
    bondingPct: c.bondingPct,
  };
}

function dexBoostToTrench(b: DexBoost): TrenchCoin | null {
  if (b.chainId !== "solana" || !b.tokenAddress) return null;
  const twitter = b.links?.find((l) => l.type === "twitter")?.url ?? null;
  const telegram = b.links?.find((l) => l.type === "telegram")?.url ?? null;
  const website =
    b.links?.find((l) => l.type === "website" || (!l.type && l.url?.startsWith("http")))?.url ??
    null;
  return {
    mint: b.tokenAddress,
    name: b.description?.slice(0, 80) ?? null,
    symbol: null,
    complete: false,
    vSol: null,
    usdMarketCap: null,
    createdAt: null,
    lastTradeAt: null,
    imageUri: b.icon
      ? `https://cdn.dexscreener.com/cms/images/${b.icon}?width=64&height=64`
      : null,
    twitter,
    telegram,
    website,
    creator: null,
    replyCount: 0,
    bondingPct: null,
  };
}

async function fetchDexTrendingMints(limit = 24): Promise<TrenchCoin[]> {
  try {
    const r = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
      next: { revalidate: 30 },
    });
    if (!r.ok) return [];
    const rows = (await r.json()) as DexBoost[];
    return rows
      .map(dexBoostToTrench)
      .filter((c): c is TrenchCoin => c != null)
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function hydrateMissingPump(coins: TrenchCoin[]): Promise<TrenchCoin[]> {
  const need = coins.filter((c) => c.vSol == null && c.mint.endsWith("pump")).slice(0, 6);
  if (!need.length) return coins;

  const byMint = new Map(coins.map((c) => [c.mint, c]));
  await Promise.all(
    need.map(async (c) => {
      try {
        const p = await cached(`pump:coin:${c.mint}`, 30_000, () => fetchPumpFunCoin(c.mint));
        if (p) byMint.set(c.mint, pumpToTrench(p));
      } catch {
        /* ignore */
      }
    }),
  );
  return coins.map((c) => byMint.get(c.mint) ?? c);
}

function dedupeCoins(coins: TrenchCoin[]): TrenchCoin[] {
  const seen = new Set<string>();
  const out: TrenchCoin[] = [];
  for (const c of coins) {
    if (seen.has(c.mint)) continue;
    seen.add(c.mint);
    out.push(c);
  }
  return out;
}

function withInterimAnalysis(c: TrenchCoin, analysis: MarketCoinAnalysis): MarketCoinAnalysis {
  if (analysis.primaryFlag !== "scanning") return analysis;
  if (c.vSol != null || c.createdAt != null) {
    return {
      ...analysis,
      primaryFlag: "warming_up",
      flagLabel: "Warming up",
      actionLabel: "Warming up",
      tradeableReason: "Waiting for first local scores",
    };
  }
  return analysis;
}

function attachAnalysis(
  coins: TrenchCoin[],
  source: MarketCoin["source"],
  analysis: Map<string, MarketCoinAnalysis>,
): MarketCoin[] {
  return coins.map((c) => {
    const base = analysis.get(c.mint) ?? SCANNING;
    return {
      ...c,
      source,
      analysis: withInterimAnalysis(c, base),
    };
  });
}

async function fetchDiscoverySlice(): Promise<DiscoverySlice> {
  return cached("market:discovery:v2", 6_000, async () => {
    const [trenches, dexTrending, gmgnNew] = await Promise.all([
      fetchTrenchesFeed(),
      fetchDexTrendingMints(20),
      tryFetchGmgnRank("open_timestamp", "1h", 15),
    ]);

    const gmgnUsed = gmgnNew.length > 0;
    const newBase = gmgnUsed ? gmgnNew : trenches.new.map(pumpToTrench);
    const trendingBase = dedupeCoins([
      ...trenches.almostBonded.map(pumpToTrench),
      ...dexTrending,
    ]).slice(0, 36);
    const migratedBase = trenches.migrated.map(pumpToTrench);
    const allMints = dedupeCoins([...newBase, ...trendingBase, ...migratedBase]).map(
      (c) => c.mint,
    );

    return {
      newBase,
      trendingBase,
      migratedBase,
      allMints,
      sources: {
        pump: true,
        dexscreener: dexTrending.length > 0,
        gmgn: gmgnUsed,
      },
    };
  });
}

async function getEnrichment(mints: string[]): Promise<Map<string, MarketCoinAnalysis>> {
  const key = mintCacheKey(mints);
  const now = Date.now();
  const ttl = 20_000;

  if (enrichState.key === key && now - enrichState.at < ttl) {
    return enrichState.data;
  }

  if (
    enrichState.key === key &&
    enrichState.data.size > 0 &&
    !enrichState.refreshing &&
    now - enrichState.at < ttl * 3
  ) {
    enrichState.refreshing = true;
    void enrichMarketMints(mints)
      .then((data) => {
        enrichState = { key, at: Date.now(), data, refreshing: false };
      })
      .catch(() => {
        enrichState.refreshing = false;
      });
    return enrichState.data;
  }

  const data = await cached(`market:enrich:${key}`, ttl, () => enrichMarketMints(mints));
  enrichState = { key, at: Date.now(), data, refreshing: false };
  return data;
}

export async function buildMarketFeed(): Promise<MarketFeed> {
  const discovery = await fetchDiscoverySlice();
  const analysis = await getEnrichment(discovery.allMints);

  const hydratedNew = await hydrateMissingPump(discovery.newBase);
  const hydratedTrending = await hydrateMissingPump(discovery.trendingBase);

  return {
    new: attachAnalysis(hydratedNew, discovery.sources.gmgn ? "gmgn" : "pump", analysis),
    trending: attachAnalysis(hydratedTrending, "dexscreener", analysis),
    migrated: attachAnalysis(discovery.migratedBase, "pump", analysis),
    sources: discovery.sources,
  };
}
