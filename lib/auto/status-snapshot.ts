import "server-only";
import {
  getActiveSession,
  getLatestSession,
  fetchSessionTrades,
  DEFAULT_PARAMS,
  type AutoSessionDto,
} from "@/lib/db/repos/auto-sessions";
import { peekKeypair } from "@/lib/wallet/session";
import { autoDemoRelaxEnabled, env } from "@/lib/env";
import { readState } from "@/lib/circuit-breaker/state";
import { countPendingBuyDecisions } from "@/lib/db/repos/paper-trades";

export type AutoStatusSnapshot = {
  active: boolean;
  session: AutoSessionDto | null;
  defaultParams: typeof DEFAULT_PARAMS;
  canRunLive: boolean;
  cbState: string;
  walletUnlocked: boolean;
  liveExecution: "on" | "off";
  liveDryRun: "on" | "off";
  trades: Awaited<ReturnType<typeof fetchSessionTrades>>;
  pendingBuyCount: number;
  lastTickAt: string | null;
};

export async function fetchAutoStatusSnapshot(includeTrades = false): Promise<AutoStatusSnapshot> {
  const active = await getActiveSession();
  const latest = active ?? (await getLatestSession());
  const trades = includeTrades && latest ? await fetchSessionTrades(latest.id, 30) : [];
  const cb = await readState();
  const e = env();
  const pendingBuyCount = active
    ? await countPendingBuyDecisions(90, { relaxAutoGate: autoDemoRelaxEnabled() })
    : 0;
  return {
    active: !!active,
    session: latest,
    defaultParams: DEFAULT_PARAMS,
    canRunLive: e.LIVE_EXECUTION === "on" && !!peekKeypair(),
    cbState: cb.state,
    walletUnlocked: !!peekKeypair(),
    liveExecution: e.LIVE_EXECUTION,
    liveDryRun: e.LIVE_DRY_RUN,
    trades,
    pendingBuyCount,
    lastTickAt: latest?.stats?.lastTickAt ?? null,
  };
}
