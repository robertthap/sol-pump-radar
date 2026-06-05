"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import Link from "next/link";

import { shortAddr, relTime } from "@/lib/ui/format";

import { logKindLabel, logSourceLabel, formatAutoSkip } from "@/lib/ui/plain-labels";

import { useTradePage } from "@/components/trade/TradePageProvider";

import { getJson } from "@/lib/ui/client-get";

import { loadLiveTradeLogVisible, saveLiveTradeLogVisible } from "@/lib/ui/trade-log-prefs";

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



type AutoDiagnostics = {

  workersRunning: boolean;

  workersExpected: boolean;

  pendingBuy90s: number;

  hint: string | null;

  lastSkipReasons?: string[];

  tradesOpened: number;

};



function kindClass(kind: LogEntry["kind"]) {

  if (kind === "open") return "border-ok/50 bg-ok/10 text-ok";

  if (kind === "close") return "border-accent/40 bg-accent/10 text-accent";

  if (kind === "skip") return "border-warn/40 bg-warn/10 text-warn";

  return "border-ok/30 bg-ok/5 text-ok";

}



function sourceLabel(source: LogEntry["source"]) {

  return logSourceLabel(source);

}



export function AutoTradeLog() {

  const { auto, log: bootLog, setFocusMint } = useTradePage();

  const active = auto?.active ?? bootLog?.active ?? false;

  const [entries, setEntries] = useState<LogEntry[]>(bootLog?.entries ?? []);

  const [pendingBuyCount, setPendingBuyCount] = useState(bootLog?.pendingBuyCount ?? 0);

  const [tradesOpened, setTradesOpened] = useState(bootLog?.tradesOpened ?? 0);

  const [diagnostics, setDiagnostics] = useState<AutoDiagnostics | null>(null);

  const [now, setNow] = useState(0);

  const newestTs = useRef<string | null>(null);

  const lastSessionId = useRef<string | null>(bootLog?.sessionId ?? null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const stickBottom = useRef(true);

  const [logVisible, setLogVisible] = useState(true);



  useEffect(() => {

    setLogVisible(loadLiveTradeLogVisible());

  }, []);



  useEffect(() => {

    if (!bootLog) return;

    setEntries(bootLog.entries);

    setPendingBuyCount(bootLog.pendingBuyCount);

    setTradesOpened(bootLog.tradesOpened);

    lastSessionId.current = bootLog.sessionId;

    newestTs.current = null;

    if (bootLog.sessionId && bootLog.entries.length === 0) {
      void getJson<{
        entries: LogEntry[];
        pendingBuyCount?: number;
        tradesOpened?: number;
      }>(`/api/auto/log?limit=30`, 0).then((j) => {
        if (!j) return;
        setEntries(j.entries ?? []);
        setPendingBuyCount(j.pendingBuyCount ?? bootLog.pendingBuyCount);
        setTradesOpened(j.tradesOpened ?? bootLog.tradesOpened);
      });
    }

  }, [bootLog]);



  const loadIncremental = useCallback(async () => {

    if (!active) return;

    try {

      const params = new URLSearchParams({ limit: "40" });

      if (newestTs.current) params.set("since", newestTs.current);

      const j = await getJson<{

        active: boolean;

        sessionId: string | null;

        entries: LogEntry[];

        pendingBuyCount?: number;

        tradesOpened?: number;

      }>(`/api/auto/log?${params}`, 0);

      if (!j) return;

      setPendingBuyCount(j.pendingBuyCount ?? 0);

      setTradesOpened(j.tradesOpened ?? 0);

      if (j.sessionId && j.sessionId !== lastSessionId.current) {

        lastSessionId.current = j.sessionId;

        newestTs.current = null;

        setEntries(j.entries ?? []);

        return;

      }

      const batch = j.entries ?? [];

      if (batch.length === 0) return;

      if (newestTs.current) {

        setEntries((prev) => {

          const seen = new Set(prev.map((e) => e.id));

          const fresh = batch.filter((e) => !seen.has(e.id));

          if (fresh.length === 0) return prev;

          return [...fresh, ...prev].slice(0, 120);

        });

      } else {

        setEntries(batch);

      }

      const latest = batch.reduce<string | null>((best, e) => {

        if (!best || e.ts > best) return e.ts;

        return best;

      }, newestTs.current);

      if (latest) newestTs.current = latest;

    } catch {

      /* ignore */

    }

  }, [active]);



  const loadDiagnostics = useCallback(async () => {

    if (!active || tradesOpened > 0) return;

    const j = await getJson<

      AutoDiagnostics & { session?: { stats?: { lastSkipReasons?: string[] } } }

    >("/api/auto/diagnostics", 15_000);

    if (!j) return;

    setDiagnostics({

      workersRunning: j.workersRunning,

      workersExpected: j.workersExpected,

      pendingBuy90s: j.pendingBuy90s,

      hint: j.hint,

      lastSkipReasons: j.session?.stats?.lastSkipReasons,

      tradesOpened: j.tradesOpened,

    });

  }, [active, tradesOpened]);



  useVisibleInterval(() => void loadIncremental(), active && logVisible ? 5_000 : 0, [loadIncremental, active, logVisible]);

  useVisibleInterval(() => setNow(Date.now()), 2_000, []);



  useEffect(() => {

    if (!active) {

      setDiagnostics(null);

      return;

    }

    const t = window.setTimeout(() => void loadDiagnostics(), 2_500);

    return () => window.clearTimeout(t);

  }, [active, tradesOpened, loadDiagnostics]);



  useEffect(() => {

    if (!stickBottom.current || !scrollRef.current) return;

    scrollRef.current.scrollTop = 0;

  }, [entries.length]);



  const onScroll = () => {

    const el = scrollRef.current;

    if (!el) return;

    stickBottom.current = el.scrollTop < 40;

  };



  if (!active && entries.length === 0) return null;



  if (!logVisible) {

    return (

      <section className="card overflow-hidden">

        <div className="flex items-center justify-between px-4 py-2">

          <p className="text-sm text-muted">Live trade log hidden</p>

          <button

            type="button"

            className="rounded border border-border px-2 py-1 text-[10px] text-accent hover:bg-panel"

            onClick={() => {

              setLogVisible(true);

              saveLiveTradeLogVisible(true);

            }}

          >

            Show log

          </button>

        </div>

      </section>

    );

  }



  return (

    <section className={`card overflow-hidden ${active ? "ring-1 ring-ok/30" : ""}`}>

      <header className="flex items-center justify-between border-b border-border px-4 py-2">

        <div>

          <h3 className="text-sm font-semibold">Live trade log</h3>

          <p className="text-[10px] text-muted">

            {active ? "Updates every ~10s while running" : "Last session activity"}

          </p>

        </div>

        <div className="flex items-center gap-2">
          {active && (
            <span className="flex items-center gap-1.5 text-[10px] text-ok">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
              Live
            </span>
          )}
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-panel"
            onClick={() => {
              setLogVisible(false);
              saveLiveTradeLogVisible(false);
            }}
          >
            Hide log
          </button>
        </div>

      </header>



      {active && tradesOpened === 0 && diagnostics && (

        <div className="border-b border-border/60 bg-panel/40 px-4 py-2 text-[10px] text-muted">

          <p>

            Pipeline:{" "}

            <span className={diagnostics.workersRunning ? "text-ok" : "text-warn"}>

              {diagnostics.workersRunning

                ? "Auto-trader running"

                : diagnostics.workersExpected

                  ? "Auto-trader idle (no recent activity)"

                  : "Background services off"}

            </span>

            {" · "}

            {diagnostics.pendingBuy90s} buys queued (last 90s)

          </p>

          {diagnostics.hint && <p className="mt-1 text-warn">{diagnostics.hint}</p>}

          {diagnostics.lastSkipReasons && diagnostics.lastSkipReasons.length > 0 && (

            <p className="mt-1">Last tick filters: {diagnostics.lastSkipReasons.join("; ")}</p>

          )}

        </div>

      )}



      <div

        ref={scrollRef}

        onScroll={onScroll}

        className="max-h-[320px] overflow-y-auto font-mono text-[11px]"

      >

        {entries.length === 0 ? (

          <p className="px-4 py-8 text-center text-muted">

            {active

              ? pendingBuyCount > 0

                ? `Waiting for qualifying signals (${pendingBuyCount} pending buy${pendingBuyCount === 1 ? "" : "s"})…`

                : diagnostics?.workersExpected === false

                  ? "Background services are not running. Open System status from the top banner."

                  : diagnostics && diagnostics.pendingBuy90s === 0

                    ? "No buys queued yet — the bot is watching for qualifying signals."

                    : "Waiting for qualifying buy signals..."

              : "Waiting for auto-trade activity…"}

          </p>

        ) : (

          <ul className="divide-y divide-border/40">

            {entries.map((e) => (

              <li key={e.id} className="flex flex-wrap items-start gap-2 px-3 py-2 hover:bg-panel/50">

                <span className="shrink-0 whitespace-nowrap text-[10px] text-muted">

                  {now > 0 ? relTime(e.ts, now) : "…"}

                </span>

                <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] ${kindClass(e.kind)}`}>

                  {logKindLabel(e.kind)}

                </span>

                <span className="shrink-0 text-[9px] uppercase text-muted">{sourceLabel(e.source)}</span>

                {e.mint && (
                  <Link
                    href={`/token/${e.mint}`}
                    className="shrink-0 text-accent hover:underline"
                    onClick={(ev) => {
                      setFocusMint(e.mint);
                      if (!(ev.metaKey || ev.ctrlKey)) ev.preventDefault();
                    }}
                  >
                    {e.symbol ?? shortAddr(e.mint, 4, 4)}
                  </Link>
                )}

                {e.kind === "skip" ? (
                  (() => {
                    const s = formatAutoSkip(e.message);
                    return (
                      <span
                        className="min-w-0 flex-1 text-muted"
                        title={`${s.hint}\n\n(${e.message})`}
                      >
                        {s.label}
                      </span>
                    );
                  })()
                ) : (
                  <span className="min-w-0 flex-1 text-muted">{e.message}</span>
                )}

                {e.pnlSol != null && (

                  <span className={`shrink-0 ${e.pnlSol >= 0 ? "text-ok" : "text-bad"}`}>

                    {e.pnlSol >= 0 ? "+" : ""}

                    {e.pnlSol.toFixed(4)} SOL

                  </span>

                )}

              </li>

            ))}

          </ul>

        )}

      </div>

    </section>

  );

}

