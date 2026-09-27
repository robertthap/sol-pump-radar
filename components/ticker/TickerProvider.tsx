"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { pickPollMs, type TickerResponse } from "@/lib/auto/ticker-snapshot";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { useTradingMode } from "@/components/TradingModeProvider";

/**
 * The single live-data loop for /trade.
 *
 *   /trade  ->  /api/ticker   (and nothing else, repeatedly)
 *
 * Cadence comes from pickPollMs(): 1 s with open positions, 5 s while the bot
 * runs with none open, 0 when the session is stopped (one fetch on mount so the
 * screen knows its state; Start re-arms via refresh()). useVisibleInterval stops
 * the loop entirely while the tab is hidden. Consecutive failures back off to
 * 15 s and are surfaced as an error the UI shows next to the last good value -
 * never as a current value.
 *
 * Uses a plain deduped fetch rather than lib/ui/client-get's getJson: in
 * development that helper POSTs a perf sample to /api/diagnostics/runtime for
 * every /api call, which would make the ticker's "one request per tick" two.
 */

export type SparklineTarget =
  | { kind: "portfolio" }
  | { kind: "position"; id: string; mint: string; symbol: string | null };

export type SeriesPoint = [tMs: number, value: number];

type TickerState = {
  data: TickerResponse | null;
  error: string | null;
  /** Wall-clock of the last successful fetch; null before the first. */
  lastOkAt: number | null;
  /** Client clock, advanced once per second while visible - for "Updated Ns ago". */
  now: number;
  pollMs: number;
  target: SparklineTarget;
  setTarget: (t: SparklineTarget) => void;
  /** Series for the current target - live, this tab only. */
  series: SeriesPoint[];
  /** Current-market-cap history for one exact trade, keyed by position id. */
  seriesForPosition: (positionId: string) => SeriesPoint[];
  refresh: () => Promise<void>;
  /** Wipe the recorded P&L history (storage + memory) — used by the demo reset. */
  clearSeries: () => void;
  /** One throttled, human sentence for the status live region. */
  statusSentence: string;
};

const Ctx = createContext<TickerState | null>(null);

const SERIES_CAP = 600; // ~10 min at 1 s
const SERIES_KEY = "spr_ticker_series_v2";
const STATUS_THROTTLE_MS = 30_000;

function targetKey(t: SparklineTarget): string {
  return t.kind === "portfolio" ? "portfolio" : `pnl:${t.id}`;
}

function loadSeries(): Record<string, SeriesPoint[]> {
  try {
    const raw = sessionStorage.getItem(SERIES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SeriesPoint[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Broadcast so a mounted provider drops its IN-MEMORY series too. */
const SERIES_CLEARED_EVENT = "spr:ticker-series-cleared";

/**
 * Drop the recorded P&L history for this tab.
 *
 * Callable from anywhere: TopNav renders OUTSIDE TickerProvider, so it cannot
 * reach the provider's state directly -- clearing only storage there left the
 * in-memory series alive, and the next poll wrote it straight back. The event
 * closes that gap without coupling the nav to the provider's position in the
 * tree. Also safe on /wallet, where no provider is mounted at all.
 */
export function clearTickerSeries() {
  try {
    sessionStorage.removeItem(SERIES_KEY);
  } catch {
    /* storage unavailable - nothing to clear */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SERIES_CLEARED_EVENT));
}

function saveSeries(s: Record<string, SeriesPoint[]>) {
  try {
    sessionStorage.setItem(SERIES_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable - live history simply does not survive a reload */
  }
}

function describe(d: TickerResponse): string {
  const p = d.portfolio;
  const dir = p.totalPnlSol > 0 ? "Up" : p.totalPnlSol < 0 ? "Down" : "Flat";
  const pct = Math.abs(p.unrealizedPct * 100).toFixed(1);
  const bot = d.bot.running ? "bot running" : "bot stopped";
  const n = p.openCount;
  return `${dir} ${Math.abs(p.totalPnlSol).toFixed(3)} SOL, ${pct} percent on open positions, ${n} position${n === 1 ? "" : "s"}, ${bot}.`;
}

export function TickerProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<TickerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [failures, setFailures] = useState(0);
  const [target, setTarget] = useState<SparklineTarget>({ kind: "portfolio" });
  const [seriesMap, setSeriesMap] = useState<Record<string, SeriesPoint[]>>({});
  const [statusSentence, setStatusSentence] = useState("");
  const statusAtRef = useRef(0);
  const statusKeyRef = useRef("");
  const inflight = useRef<Promise<void> | null>(null);
  const { hydrate } = useTradingMode();
  const hydrateRef = useRef(hydrate);
  hydrateRef.current = hydrate;

  // Restore live-session history for this tab (not durable history).
  useEffect(() => {
    setSeriesMap(loadSeries());
  }, []);

  // A demo reset wipes the ledger; the recorded curve must go with it.
  useEffect(() => {
    const onCleared = () => {
      setSeriesMap({});
      setTarget({ kind: "portfolio" });
    };
    window.addEventListener(SERIES_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(SERIES_CLEARED_EVENT, onCleared);
  }, []);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      try {
        const r = await fetch("/api/ticker", { cache: "no-store" });
        const j = (await r.json()) as TickerResponse & { error?: string };
        if (!r.ok || j.sourceStatus === "error") {
          throw new Error(j.error ?? `http_${r.status}`);
        }
        const t = Date.now();
        setData(j);
        setError(null);
        setFailures(0);
        setLastOkAt(t);
        setNow(t);
        // Feed the global mode provider so it never polls mode-lite on this page.
        hydrateRef.current(j.mode);
        // Append to every series that has a live value: portfolio + each open position.
        setSeriesMap((prev) => {
          const next: Record<string, SeriesPoint[]> = { ...prev };
          const push = (key: string, v: number) => {
            const arr = next[key] ? next[key].slice(-(SERIES_CAP - 1)) : [];
            arr.push([t, v]);
            next[key] = arr;
          };
          push("portfolio", j.portfolio.totalPnlSol);
          const openKeys = new Set<string>(["portfolio"]);
          for (const p of j.positions) {
            const pnlKey = `pnl:${p.id}`;
            const marketKey = `mcap:${p.id}`;
            openKeys.add(pnlKey);
            openKeys.add(marketKey);
            if (p.pnlSol != null && Number.isFinite(p.pnlSol)) push(pnlKey, p.pnlSol);
            if (p.currentMcapUsd != null && Number.isFinite(p.currentMcapUsd)) {
              push(marketKey, p.currentMcapUsd);
            }
          }
          // Drop series for positions that are no longer open so storage stays bounded.
          for (const k of Object.keys(next)) if (!openKeys.has(k)) delete next[k];
          saveSeries(next);
          return next;
        });
        // Status region: one atomic sentence, at most every 30 s, or immediately on a
        // meaningful state change (source status / bot running / position count).
        const key = `${j.sourceStatus}|${j.bot.running}|${j.portfolio.openCount}`;
        if (key !== statusKeyRef.current || t - statusAtRef.current >= STATUS_THROTTLE_MS) {
          statusKeyRef.current = key;
          statusAtRef.current = t;
          setStatusSentence(describe(j));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setFailures((n) => Math.min(6, n + 1));
        setNow(Date.now());
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  // Cadence. Visibility is handled inside useVisibleInterval (it stops when hidden),
  // so `visible: true` here; the pure policy is unit-tested with both values.
  const basePollMs = pickPollMs({
    visible: true,
    openCount: data?.portfolio.openCount ?? 0,
    botRunning: data?.bot.running ?? false,
    hasSession: !!data?.session,
  });
  const pollMs = failures > 0 ? Math.min(15_000, Math.max(basePollMs, 1_000) * 2 ** failures) : basePollMs;

  useVisibleInterval(() => void refresh(), pollMs, [refresh]);

  // Stopped / no session: the interval is 0, so fetch once on mount to learn the state.
  useEffect(() => {
    if (data == null) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clock for age labels; only needed when we are NOT already ticking at 1 s.
  useVisibleInterval(() => setNow(Date.now()), pollMs === 1_000 ? 0 : 1_000, [pollMs]);

  // If the selected position closes, return to the portfolio series.
  useEffect(() => {
    if (target.kind === "position" && data && !data.positions.some((p) => p.id === target.id)) {
      setTarget({ kind: "portfolio" });
    }
  }, [data, target]);

  const series = useMemo(() => seriesMap[targetKey(target)] ?? [], [seriesMap, target]);
  const seriesForPosition = useCallback(
    (positionId: string) => seriesMap[`mcap:${positionId}`] ?? [],
    [seriesMap],
  );

  // clearTickerSeries() broadcasts; the listener above does the state work, so
  // this behaves identically whether called from inside or outside the provider.
  const clearSeries = useCallback(() => clearTickerSeries(), []);

  const value = useMemo<TickerState>(
    () => ({ data, error, lastOkAt, now, pollMs, target, setTarget, series, seriesForPosition, refresh, clearSeries, statusSentence }),
    [data, error, lastOkAt, now, pollMs, target, series, seriesForPosition, refresh, clearSeries, statusSentence],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside /trade - lets the global nav show bot state when the ticker is mounted. */
export function useTickerOptional(): TickerState | null {
  return useContext(Ctx);
}

export function useTicker(): TickerState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTicker outside TickerProvider");
  return v;
}
