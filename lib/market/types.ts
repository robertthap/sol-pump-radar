/** Shared market coin types (client + server). */


export type MarketPrimaryFlag =
  | "strong_buy"
  | "buy"
  | "watch"
  | "tradable"
  | "caution"
  | "wait"
  | "avoid"
  | "rug"
  | "scanning"
  | "warming_up";

export type MarketCoinAnalysis = {
  action: string | null;
  actionLabel: string;
  confluenceScore: number | null;
  gradScore: number | null;
  rugScore: number | null;
  qualityScore: number;
  qualityTier: "hot" | "good" | "fair" | "weak" | "avoid";
  tradable: boolean;
  tradeableStatus: "yes" | "no" | "caution" | "wait";
  tradeableReason: string;
  rugLabel: string | null;
  hasBundle: boolean;
  hasSniper: boolean;
  mechanicalUptrend: boolean;
  smartMoneyCount: number;
  tags: string[];
  primaryFlag: MarketPrimaryFlag;
  flagLabel: string;
};

export type MarketCoin = TrenchCoin & {
  analysis: MarketCoinAnalysis;
  source?: "pump" | "dexscreener" | "gmgn";
};

export type MarketFeed = {
  new: MarketCoin[];
  trending: MarketCoin[];
  migrated: MarketCoin[];
  sources: { pump: boolean; dexscreener: boolean; gmgn: boolean };
};

export type MarketFilter = "all" | "tradable" | "strong_buy" | "avoid";

export function matchesMarketFilter(coin: MarketCoin, filter: MarketFilter): boolean {
  if (filter === "all") return true;
  const f = coin.analysis.primaryFlag;
  if (filter === "tradable") {
    return coin.analysis.tradable || f === "tradable" || f === "strong_buy" || f === "buy";
  }
  if (filter === "strong_buy") return f === "strong_buy" || f === "buy";
  if (filter === "avoid") {
    return f === "avoid" || f === "rug" || coin.analysis.action === "AVOID";
  }
  return true;
}

/** A pump.fun coin as the market discovery/trenches pipeline sees it (moved from the deleted TrenchCoinCard component). */
export type TrenchCoin = {
  mint: string;
  name: string | null;
  symbol: string | null;
  complete: boolean;
  vSol: number | null;
  usdMarketCap: number | null;
  createdAt: string | null;
  lastTradeAt: string | null;
  imageUri: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  creator: string | null;
  replyCount: number;
  bondingPct: number | null;
  analysis?: MarketCoinAnalysis;
};
