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
import { usePathname, useRouter } from "next/navigation";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { getJson, invalidateClientGet } from "@/lib/ui/client-get";
import { pollCommandStatus } from "@/lib/trade-client";

export type UiTradingMode = "demo" | "real";

type DemoAccount = {
  startSol: number;
  balanceSol: number;
  equitySol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  lockedSol: number;
  openPositions: number;
  closedTrades: number;
};

type ModeLitePayload = {
  mode: UiTradingMode | null;
  needsSelection: boolean;
  /** A genuine live session (open positions / running auto-trader), not just a saved mode. */
  activeSession?: boolean;
  demo: DemoAccount;
  real: { walletUnlocked: boolean; liveExecution: "on" | "off" };
  shadowLearner: { enabled: boolean };
};

type ModeState = {
  mode: UiTradingMode | null;
  needsSelection: boolean;
  /** A genuine live session (open positions / running auto-trader), not just a saved mode. */
  activeSession: boolean;
  demo: DemoAccount | null;
  shadowEnabled: boolean;
  walletUnlocked: boolean;
  liveExecution: "on" | "off";
  loading: boolean;
  setMode: (m: UiTradingMode) => Promise<void>;
  /** End the current Demo or Real session and return to the home wallet chooser. */
  exitSession: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Trade bootstrap can push mode once and skip duplicate polls. */
  hydrate: (payload: ModeLitePayload) => void;
};

const Ctx = createContext<ModeState | null>(null);

const LS_KEY = "spr_trading_mode";
const MODE_SYNC_KEY = "spr_trading_mode_db_synced";

function readStoredMode(): UiTradingMode | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(LS_KEY);
  return v === "demo" || v === "real" ? v : null;
}

function needsFullDemo(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname.startsWith("/wallet") || pathname.startsWith("/token/");
}

export function TradingModeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // Initialize to the SERVER's values (null / needs-selection) so the first client
  // render matches SSR. Reading localStorage in useState would diverge from the
  // server and cause a hydration mismatch; the mount effect below hydrates the
  // real mode from localStorage right after.
  const [mode, setModeState] = useState<UiTradingMode | null>(null);
  const [needsSelection, setNeedsSelection] = useState(true);
  const [activeSession, setActiveSession] = useState(false);
  const [demo, setDemo] = useState<DemoAccount | null>(null);
  const [shadowEnabled, setShadowEnabled] = useState(true);
  const [walletUnlocked, setWalletUnlocked] = useState(false);
  const [liveExecution, setLiveExecution] = useState<"on" | "off">("off");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Optimistically reflect the last-chosen wallet for an instant first paint. The
    // SERVER is authoritative — refresh() reconciles right after and logs out if the
    // server has no mode (e.g. after a worker restart clears it). We intentionally do
    // NOT re-push a stored mode to the server here; only an explicit pick (setMode)
    // establishes a session, so a restarted system starts logged out.
    const stored = readStoredMode();
    if (!stored) return;
    setModeState(stored);
    setNeedsSelection(false);
  }, []);

  const applyModePayload = useCallback((j: ModeLitePayload) => {
    // Server is authoritative. Do NOT resurrect a stale localStorage mode when the
    // server reports none — clear it so the user is genuinely logged out (e.g. after a
    // worker restart) and must pick a wallet again. Mirror the server into localStorage.
    if (j.mode === "demo" || j.mode === "real") {
      setModeState(j.mode);
      setNeedsSelection(false);
      if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, j.mode);
    } else {
      setModeState(null);
      setNeedsSelection(j.needsSelection);
      if (typeof localStorage !== "undefined") localStorage.removeItem(LS_KEY);
    }
    setActiveSession(j.activeSession ?? false);
    setDemo(j.demo);
    setShadowEnabled(j.shadowLearner?.enabled ?? true);
    setWalletUnlocked(j.real?.walletUnlocked ?? false);
    setLiveExecution(j.real?.liveExecution ?? "off");
    setLoading(false);
  }, []);

  const hydrate = useCallback(
    (payload: ModeLitePayload) => {
      applyModePayload(payload);
    },
    [applyModePayload],
  );

  const refresh = useCallback(async () => {
    const full = needsFullDemo(pathname);
    const endpoint = full ? "/api/settings/mode" : "/api/settings/mode-lite";
    const j = await getJson<ModeLitePayload>(endpoint, full ? 0 : 12_000);
    if (!j) return;
    applyModePayload(j);
  }, [pathname, applyModePayload]);

  const onTradePage = pathname.startsWith("/trade");

  useEffect(() => {
    if (onTradePage) return;
    const t = window.setTimeout(() => void refresh(), 80);
    return () => window.clearTimeout(t);
  }, [refresh, onTradePage]);

  const pollMs = onTradePage
    ? mode === "demo"
      ? 8_000
      : 30_000
    : mode === "demo"
      ? needsFullDemo(pathname)
        ? 20_000
        : 45_000
      : 90_000;
  useVisibleInterval(refresh, pollMs, [refresh, pollMs]);

  const exitSession = useCallback(async () => {
    localStorage.removeItem(LS_KEY);
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(MODE_SYNC_KEY);
    }
    setModeState(null);
    setNeedsSelection(true);
    setActiveSession(false);
    invalidateClientGet();
    setDemo(null);
    setWalletUnlocked(false);
    try {
      const r = await fetch("/api/settings/mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clearSession: true }),
      });
      if (r.status === 202) {
        const j = (await r.json()) as { correlationId?: string };
        if (j.correlationId) await pollCommandStatus(j.correlationId);
      }
    } catch {
      /* local session cleared; server may catch up on next worker tick */
    }
    router.push("/");
  }, [router]);

  const setMode = useCallback(
    async (m: UiTradingMode) => {
      const r = await fetch("/api/settings/mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: m }),
      });
      if (r.status === 202) {
        const j = (await r.json()) as { correlationId?: string };
        if (!j.correlationId) throw new Error("mode save missing correlationId");
        const polled = await pollCommandStatus(j.correlationId);
        if (!polled.ok) throw new Error(polled.error ?? "mode save failed");
      } else if (!r.ok) {
        throw new Error(`mode save failed ${r.status}`);
      }
      localStorage.setItem(LS_KEY, m);
      setModeState(m);
      setNeedsSelection(false);
      // Bust all cached GETs so positions/analytics/holdings refetch for the NEW
      // mode immediately — no prior-mode data leaking across the switch.
      invalidateClientGet();
      await refresh();
    },
    [refresh],
  );

  const value = useMemo(
    () => ({
      mode,
      needsSelection,
      activeSession,
      demo,
      shadowEnabled,
      walletUnlocked,
      liveExecution,
      loading,
      setMode,
      exitSession,
      refresh,
      hydrate,
    }),
    [
      mode,
      needsSelection,
      activeSession,
      demo,
      shadowEnabled,
      walletUnlocked,
      liveExecution,
      loading,
      setMode,
      exitSession,
      refresh,
      hydrate,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTradingMode(): ModeState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTradingMode outside provider");
  return v;
}
