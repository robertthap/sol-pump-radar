import "server-only";
import {
  fetchSmartMoneyBuyersForMint,
  fetchManySmartMoneyCounts,
  type SmartMoneyBuyer,
} from "@/lib/db/repos/bots";

export type InsiderAnalysis = {
  smartMoneyCount: number;
  avgTStat: number | null;
  topWallets: Array<{ wallet: string; tStat: number; avgReturn: number }>;
  hasInsiderEntry: boolean;
  hasStrongInsiderEntry: boolean;
  label: string;
};

export function analyzeInsiderBuyers(buyers: SmartMoneyBuyer[]): InsiderAnalysis {
  if (buyers.length === 0) {
    return {
      smartMoneyCount: 0,
      avgTStat: null,
      topWallets: [],
      hasInsiderEntry: false,
      hasStrongInsiderEntry: false,
      label: "none",
    };
  }
  const topWallets = buyers.slice(0, 3).map((b) => ({
    wallet: b.wallet,
    tStat: b.tStat ?? 0,
    avgReturn: b.avgReturn ?? 0,
  }));
  const tStats = buyers.map((b) => b.tStat ?? 0).filter((t) => t > 0);
  const avgTStat = tStats.length ? tStats.reduce((a, b) => a + b, 0) / tStats.length : null;
  const count = buyers.length;
  return {
    smartMoneyCount: count,
    avgTStat,
    topWallets,
    hasInsiderEntry: count >= 1,
    hasStrongInsiderEntry: count >= 2,
    label: count >= 3 ? "strong" : count >= 2 ? "moderate" : count >= 1 ? "weak" : "none",
  };
}

export async function analyzeMintInsiders(mint: string): Promise<InsiderAnalysis> {
  const buyers = await fetchSmartMoneyBuyersForMint(mint);
  return analyzeInsiderBuyers(buyers);
}

export { fetchManySmartMoneyCounts };
