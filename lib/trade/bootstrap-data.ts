import "server-only";
import { cached } from "@/lib/api/short-cache";
import { fetchAutoStatusSnapshot } from "@/lib/auto/status-snapshot";
import { fetchModeLiteSnapshot } from "@/lib/settings/mode-lite-snapshot";
import { fetchTradeOpportunitiesLite } from "@/lib/trade/opportunities-lite";
import { getActiveSession, getLatestSession } from "@/lib/db/repos/auto-sessions";
import { autoDemoRelaxEnabled } from "@/lib/env";
import { countPendingBuyDecisions } from "@/lib/db/repos/paper-trades";

export type TradeBootstrapLog = {
  active: boolean;
  sessionId: string | null;
  entries: [];
  pendingBuyCount: number;
  tradesOpened: number;
};

export async function buildTradeBootstrap(opts?: { lite?: boolean }) {
  const cacheKey = opts?.lite ? "trade:bootstrap:lite:v2" : "trade:bootstrap:v5";
  return cached(cacheKey, opts?.lite ? 4_000 : 6_000, async () => {
    const active = await getActiveSession();
    const latest = active ?? (await getLatestSession());

    const [mode, auto] = await Promise.all([
      fetchModeLiteSnapshot(),
      fetchAutoStatusSnapshot(false),
    ]);

    const pendingBuyCount =
      active && !opts?.lite
        ? await countPendingBuyDecisions(90, { relaxAutoGate: autoDemoRelaxEnabled() })
        : 0;

    const log: TradeBootstrapLog = {
      active: !!active,
      sessionId: latest?.id ?? null,
      entries: [],
      pendingBuyCount: opts?.lite ? 0 : pendingBuyCount,
      tradesOpened: latest?.stats?.tradesOpened ?? 0,
    };

    if (opts?.lite) {
      return {
        ts: Date.now(),
        mode,
        auto: { ...auto, pendingBuyCount: 0 },
        log,
        opportunities: [] as Awaited<ReturnType<typeof fetchTradeOpportunitiesLite>>,
      };
    }

    const opportunities = await fetchTradeOpportunitiesLite(24, 0.56);

    return {
      ts: Date.now(),
      mode,
      auto: { ...auto, pendingBuyCount },
      log,
      opportunities,
    };
  });
}
