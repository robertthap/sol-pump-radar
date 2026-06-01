import "server-only";
import { cached } from "@/lib/api/short-cache";
import { fetchTrenchesFeed } from "@/lib/pump/fun-api";
import type { TrenchCoin } from "@/components/TrenchCoinCard";

export type TrenchesUiFeed = {
  new: TrenchCoin[];
  almostBonded: TrenchCoin[];
  migrated: TrenchCoin[];
};

export async function getTrenchesFeedCached(): Promise<TrenchesUiFeed> {
  return cached("pump:trenches:ui", 12_000, async () => {
    const feed = await fetchTrenchesFeed();
    return feed as TrenchesUiFeed;
  });
}
