"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AutoStatusSnapshot } from "@/lib/auto/status-snapshot";
import type { TradeOpportunity } from "@/lib/trade/opportunities-lite";
import { useTradingMode, type UiTradingMode } from "@/components/TradingModeProvider";
import { invalidateClientGet, getJson } from "@/lib/ui/client-get";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type LogEntry = {
  id: string;
  ts: string;
  kind: "open" | "close" | "skip" | "tp1";
  mint: string | null;
  symbol: string | null;
  message: string;
  pnlSol: number | null;
  source: "paper" | "live" | "system";
};

type Bootstrap = {
  ts: number;
  mode: {
    mode: "demo" | "real" | null;
    needsSelection: boolean;
    demo: unknown;
    real: { walletUnlocked: boolean; liveExecution: "on" | "off" };
    shadowLearner: { enabled: boolean };
  };
  auto: AutoStatusSnapshot;
  log: {
    active: boolean;
    sessionId: string | null;
    entries: LogEntry[];
    pendingBuyCount: number;
    tradesOpened: number;
  };
  opportunities: TradeOpportunity[];
};

type TradePageState = {
  loading: boolean;
  auto: AutoStatusSnapshot | null;
  log: Bootstrap["log"] | null;
  opportunities: TradeOpportunity[];
  focusMint: string | null;
  setFocusMint: (mint: string | null) => void;
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
};

const Ctx = createContext<TradePageState | null>(null);

export function TradePageProvider({ children }: { children: ReactNode }) {
  const { hydrate, refresh: refreshMode } = useTradingMode();
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState<AutoStatusSnapshot | null>(null);
  const [log, setLog] = useState<Bootstrap["log"] | null>(null);
  const [opportunities, setOpportunities] = useState<TradeOpportunity[]>([]);
  const [focusMint, setFocusMint] = useState<string | null>(null);

  const applyCore = useCallback(
    (b: Bootstrap) => {
      hydrate({
        mode: b.mode.mode as UiTradingMode | null,
        needsSelection: b.mode.needsSelection,
        demo: b.mode.demo as Parameters<typeof hydrate>[0]["demo"],
        real: b.mode.real,
        shadowLearner: b.mode.shadowLearner,
      });
      setAuto(b.auto);
      setLog(b.log);
    },
    [hydrate],
  );

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    invalidateClientGet("/api/trade/bootstrap");
    invalidateClientGet("/api/trade/bootstrap?lite=1");
    invalidateClientGet("/api/auto/positions");
    invalidateClientGet("/api/settings/mode-lite");

    const lite = await getJson<Bootstrap>("/api/trade/bootstrap?lite=1", 0);
    if (lite) {
      applyCore(lite);
      setLoading(false);
    }

    const [full, logPayload, opps] = await Promise.all([
      getJson<Bootstrap>("/api/trade/bootstrap", 0),
      getJson<Bootstrap["log"] & { entries: LogEntry[] }>("/api/auto/log?limit=30", 0),
      getJson<{ opportunities: TradeOpportunity[] }>(
        "/api/trade/opportunities?limit=24&lite=1",
        8_000,
      ),
    ]);

    if (full) {
      applyCore(full);
      setLog((prev) => ({
        ...full.log,
        entries: logPayload?.entries ?? prev?.entries ?? [],
      }));
    } else if (logPayload) {
      setLog((prev) => ({
        active: logPayload.active,
        sessionId: logPayload.sessionId,
        entries: logPayload.entries,
        pendingBuyCount: logPayload.pendingBuyCount ?? prev?.pendingBuyCount ?? 0,
        tradesOpened: logPayload.tradesOpened ?? prev?.tradesOpened ?? 0,
      }));
    }

    if (opps?.opportunities) setOpportunities(opps.opportunities);
    else if (full?.opportunities) setOpportunities(full.opportunities);

    void refreshMode();

    setLoading(false);
  }, [applyCore, refreshMode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = auto?.active ?? false;
  useVisibleInterval(
    () => void refresh({ silent: true }),
    active ? 15_000 : 45_000,
    [refresh, active],
  );

  const value = useMemo(
    () => ({ loading, auto, log, opportunities, focusMint, setFocusMint, refresh }),
    [loading, auto, log, opportunities, focusMint, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTradePage(): TradePageState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTradePage outside TradePageProvider");
  return v;
}
