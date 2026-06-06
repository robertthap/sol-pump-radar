"use client";



import { useCallback, useEffect, useRef, useState } from "react";

import Link from "next/link";

import { TradingChart } from "@/components/chart/TradingChart";
import type { UserTrade } from "@/lib/chart/types";

import { useTradePage } from "@/components/trade/TradePageProvider";

import { useTradingMode, type UiTradingMode } from "@/components/TradingModeProvider";
import { PositionSourceBadge } from "@/lib/ui/position-source-badge";

import { getJson, invalidateClientGet } from "@/lib/ui/client-get";

import { shortAddr, relTime } from "@/lib/ui/format";

import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

import { submitDemoTrade, submitLiveTrade, submitSellAll } from "@/lib/trade-client";



type AutoPosition = {

  id: string;

  mint: string;

  symbol: string | null;

  name: string | null;

  source: "paper" | "live";

  status: "open" | "closed";

  sizeSol: number;

  entryVSol: number | null;

  exitVSol: number | null;

  currentVSol: number | null;

  entryMcapUsd: number | null;

  currentMcapUsd: number | null;

  bondingPct: number | null;

  pnlSol: number | null;

  pctOfSize: number | null;

  exitReason: string | null;

  openedAt: string;

  closedAt: string | null;

  action: string | null;

  imageUri: string | null;

  markers: { id: string; ts: string; side: "buy" | "sell"; vSol: number | null }[];

};



type PositionsPayload = {

  active: boolean;

  sessionId: string | null;

  open: AutoPosition[];

  closed: AutoPosition[];

  stats: {

    openCount: number;

    closedCount: number;

    realizedPnlSol: number;

    unrealizedPnlSol: number;

    totalPnlSol: number;

  };

};



function fmtMcap(v: number | null) {

  if (v == null || !Number.isFinite(v)) return "—";

  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;

  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;

  return `$${Math.round(v)}`;

}



function poolChgPct(entry: number | null, now: number | null) {
  if (entry == null || now == null || entry <= 0) return null;
  return ((now - entry) / entry) * 100;
}

function fmtPool(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)} SOL`;
}



function pnlClass(v: number | null) {

  if (v == null) return "text-muted";

  return v >= 0 ? "text-ok" : "text-bad";

}



function TokenAvatar({ p }: { p: AutoPosition }) {

  const label = (p.symbol ?? p.mint.slice(0, 2)).slice(0, 2).toUpperCase();

  if (p.imageUri) {

    return (

      // eslint-disable-next-line @next/next/no-img-element

      <img src={p.imageUri} alt="" className="h-7 w-7 shrink-0 rounded-full bg-panel object-cover" />

    );

  }

  return (

    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-panel text-[9px] font-bold text-muted">

      {label}

    </span>

  );

}



function PositionRow({

  p,

  selected,

  onSelect,

  onSell,

  busy,

  now,

  uiMode,

}: {

  p: AutoPosition;

  selected: boolean;

  onSelect: () => void;

  onSell?: () => void;

  busy?: boolean;

  now: number;

  uiMode: UiTradingMode | null;

}) {

  const label = p.symbol ?? shortAddr(p.mint, 4, 4);

  const pct =

    p.pctOfSize != null ? `${p.pctOfSize >= 0 ? "+" : ""}${(p.pctOfSize * 100).toFixed(1)}%` : null;



  return (

    <div

      className={`flex w-full items-center gap-2 border-b border-border/40 px-2 py-2 text-xs transition hover:bg-panel/60 ${

        selected ? "bg-panel/80 ring-1 ring-inset ring-accent/40" : ""

      }`}

    >

      <button

        type="button"

        onClick={onSelect}

        className="flex min-w-0 flex-1 items-center gap-2 text-left"

      >

        <TokenAvatar p={p} />

        <div className="min-w-0 flex-1">

          <div className="flex items-center gap-1.5">

            <span className="truncate font-medium">{label}</span>

            <PositionSourceBadge uiMode={uiMode} source={p.source} />

          </div>

          <p className="mt-0.5 truncate text-[10px] text-muted">
            {p.sizeSol.toFixed(3)} SOL · pool {fmtPool(p.entryVSol)}
            {p.status === "open" && p.currentVSol != null && (
              <>
                {" → "}
                {fmtPool(p.currentVSol)}
                {(() => {
                  const chg = poolChgPct(p.entryVSol, p.currentVSol);
                  return chg != null ? (
                    <span className={chg >= 0 ? " text-ok" : " text-bad"}>
                      {" "}
                      ({chg >= 0 ? "+" : ""}
                      {chg.toFixed(1)}%)
                    </span>
                  ) : null;
                })()}
              </>
            )}
            {" · mcap "}
            {fmtMcap(p.entryMcapUsd)}
            {p.status === "open" ? ` → ${fmtMcap(p.currentMcapUsd)}` : ""}
          </p>

        </div>

      </button>

      <div className="shrink-0 text-right">

        <p className={`font-mono text-xs font-semibold ${pnlClass(p.pnlSol)}`}>

          {p.pnlSol != null ? `${p.pnlSol >= 0 ? "+" : ""}${p.pnlSol.toFixed(4)}` : "—"}

        </p>

        {pct && <p className={`font-mono text-[9px] ${pnlClass(p.pnlSol)}`}>{pct}</p>}

        {now > 0 && (

          <p className="text-[9px] text-muted">

            {p.status === "closed" && p.closedAt

              ? relTime(p.closedAt, now)

              : relTime(p.openedAt, now)}

          </p>

        )}

        {p.status === "open" && onSell && (

          <button

            type="button"

            disabled={busy}

            onClick={() => onSell()}

            className="mt-0.5 rounded border border-bad/40 px-1.5 py-0.5 text-[9px] text-bad hover:bg-bad/10 disabled:opacity-50"

          >

            {busy ? "…" : "Sell"}

          </button>

        )}

      </div>

    </div>

  );

}



function PositionsBox({

  title,

  count,

  empty,

  children,

}: {

  title: string;

  count: number;

  empty: string;

  children: React.ReactNode;

}) {

  return (

    <div className="flex min-h-[180px] flex-col overflow-hidden rounded-lg border border-border/60 bg-panel/20">

      <p className="border-b border-border/40 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted">

        {title} ({count})

      </p>

      <div className="max-h-[280px] flex-1 overflow-y-auto">

        {count === 0 ? (

          <p className="px-3 py-6 text-center text-[11px] text-muted">{empty}</p>

        ) : (

          children

        )}

      </div>

    </div>

  );

}




function PositionChartPanel({

  p,

  onSell,

  busy,

  onClose,

  scrollToBuy,

}: {

  p: AutoPosition;

  onSell: () => void;

  busy: boolean;

  onClose: () => void;

  scrollToBuy?: boolean;

}) {

  const label = p.symbol ?? shortAddr(p.mint, 4, 4);
  const [userTrades, setUserTrades] = useState<UserTrade[] | undefined>();

  useEffect(() => {
    let alive = true;
    void fetch(`/api/tokens/${encodeURIComponent(p.mint)}/user-trades`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { trades: [] }))
      .then((j: { trades: UserTrade[] }) => {
        if (alive) setUserTrades(j.trades ?? []);
      })
      .catch(() => {
        if (alive) setUserTrades([]);
      });
    return () => {
      alive = false;
    };
  }, [p.mint, p.markers.length]);

  return (

    <div className="border-t border-border/60 bg-panel/10">

      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">

        <div className="flex items-center gap-2">

          <TokenAvatar p={p} />

          <div>

            <p className="text-sm font-semibold">{label}</p>

            {p.name && <p className="text-[10px] text-muted">{p.name}</p>}

          </div>

        </div>

        <div className="flex flex-wrap items-center gap-2 text-[10px]">

          <span>

            Entry <b>{fmtMcap(p.entryMcapUsd)}</b>

          </span>

          {p.status === "open" && (

            <span>

              Now <b>{fmtMcap(p.currentMcapUsd)}</b>

            </span>

          )}

          <span>

            Pool <b>{fmtPool(p.currentVSol ?? p.entryVSol)}</b>

          </span>

          {p.status === "open" && (

            <button

              type="button"

              disabled={busy}

              onClick={() => onSell()}

              className="rounded border border-bad/40 px-2 py-0.5 text-bad hover:bg-bad/10 disabled:opacity-50"

            >

              {busy ? "Selling…" : "Sell"}

            </button>

          )}

          <Link href={`/token/${p.mint}`} className="text-accent hover:underline">

            Token page →

          </Link>

          <button type="button" onClick={onClose} className="text-muted hover:underline">

            Close chart

          </button>

        </div>

      </div>



      <div className="space-y-2 px-3 pb-3">

        <TradingChart
          mint={p.mint}
          entryMcapUsd={p.entryMcapUsd}
          pnlPct={p.pctOfSize}
          status={p.status}
          userTrades={userTrades}
          scrollToBuy={scrollToBuy}
        />

      </div>



      <div className="grid grid-cols-2 gap-2 border-t border-border/40 px-3 py-2 text-[10px] sm:grid-cols-4">

        <div>

          <p className="text-muted">Size</p>

          <p className="font-mono">{p.sizeSol.toFixed(4)} SOL</p>

        </div>

        <div>

          <p className="text-muted">Entry pool</p>

          <p className="font-mono">{fmtPool(p.entryVSol)}</p>

        </div>

        <div>

          <p className="text-muted">PnL</p>

          <p className={`font-mono ${pnlClass(p.pnlSol)}`}>

            {p.pnlSol != null ? `${p.pnlSol >= 0 ? "+" : ""}${p.pnlSol.toFixed(4)} SOL` : "—"}

          </p>

        </div>

        <div>

          <p className="text-muted">Status</p>

          <p>{p.status === "open" ? "Holding" : p.exitReason ?? "Closed"}</p>

        </div>

      </div>

    </div>

  );

}



export function AutoTradePositions() {

  const { auto, log, focusMint, setFocusMint, refresh } = useTradePage();

  const { mode, refresh: refreshMode } = useTradingMode();

  const active = auto?.active ?? log?.active ?? false;

  const [data, setData] = useState<PositionsPayload | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [now, setNow] = useState(0);

  const [busyMint, setBusyMint] = useState<string | null>(null);

  const [sellAllBusy, setSellAllBusy] = useState(false);

  const [sellMsg, setSellMsg] = useState<string | null>(null);

  const chartRef = useRef<HTMLDivElement>(null);



  const load = useCallback(async () => {

    invalidateClientGet("/api/auto/positions");

    const j = await getJson<PositionsPayload>(`/api/auto/positions?limit=30&live=${active ? "1" : "0"}`, 0);

    if (!j) return;

    setData(j);

    setSelectedId((prev) => {

      const all = [...j.open, ...j.closed];

      if (prev && all.some((p) => p.id === prev)) return prev;

      return null;

    });

  }, [active]);

  useEffect(() => {
    void load();
  }, [load, auto?.session?.id, log?.sessionId]);

  useEffect(() => {

    if (!focusMint || !data) return;

    const match = [...data.open, ...data.closed].find((p) => p.mint === focusMint);

    if (match) {

      setSelectedId(match.id);

      requestAnimationFrame(() => {

        chartRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });

      });

    }

  }, [focusMint, data]);



  useVisibleInterval(() => void load(), active ? 3_500 : 15_000, [load, active]);

  useVisibleInterval(() => setNow(Date.now()), 2_000, []);



  const sellPosition = useCallback(

    async (p: AutoPosition) => {

      if (busyMint || p.status !== "open") return;

      setBusyMint(p.mint);

      try {

        if (p.source === "live" || mode === "real") {

          const _sym = p.symbol ?? shortAddr(p.mint, 4, 4);
          const _pnl =
            p.pnlSol != null ? `${p.pnlSol >= 0 ? "+" : ""}${p.pnlSol.toFixed(4)} SOL` : "unknown";
          if (
            !window.confirm(
              `REAL on-chain sell — this spends real SOL.\n\n` +
                `Sell 100% of ${_sym} (${p.sizeSol.toFixed(4)} SOL position)?\n` +
                `Unrealized PnL: ${_pnl}\n` +
                `A ~1% pump fee + slippage apply.`,
            )
          ) {
            return;
          }
          const j = await submitLiveTrade("/api/trade/quick-sell", {

            mint: p.mint,

            percent: 100,

            vSol: p.currentVSol ?? undefined,

          });

          if (j.ok) {

            invalidateClientGet("/api/auto/positions");

            await load();

            await refresh({ silent: true });

            await refreshMode();

          }

        } else {

          const j = await submitDemoTrade({

            mint: p.mint,

            side: "sell",

            vSol: p.currentVSol ?? undefined,

          });

          if (j.ok) {

            invalidateClientGet("/api/auto/positions");

            await load();

            await refresh({ silent: true });

            await refreshMode();

          }

        }

      } finally {

        setBusyMint(null);

      }

    },

    [busyMint, load, mode, refresh, refreshMode],

  );



  const sellAll = useCallback(

    async (scope: "auto" | "all") => {

      if (sellAllBusy) return;

      const openCount = data?.open?.length ?? 0;

      const label =

        scope === "auto"

          ? `Sell all ${openCount} open auto position${openCount === 1 ? "" : "s"}?`

          : "Sell ALL open holdings (auto + manual demo)?";

      if (scope === "auto" && openCount === 0) return;

      const _totalSol = (data?.open ?? []).reduce((a, p) => a + (p.sizeSol || 0), 0);
      const _isReal = (data?.open ?? []).some((p) => p.source === "live");
      const _detail =
        `${label}\n\nTotal size: ${_totalSol.toFixed(4)} SOL across ${openCount} position(s).` +
        (_isReal
          ? `\n\nREAL on-chain — this sells everything for real SOL. A ~1% fee + slippage apply.`
          : ``);
      if (!window.confirm(_detail)) return;



      setSellAllBusy(true);

      setSellMsg(null);

      try {

        const j = await submitSellAll({

          scope,

          sessionId: scope === "auto" ? data?.sessionId ?? undefined : undefined,

        });

        if (j.ok) {

          setSellMsg(

            `Closed ${j.closedCount} position${j.closedCount === 1 ? "" : "s"}${

              j.totalPnlSol != null

                ? ` · PnL ${j.totalPnlSol >= 0 ? "+" : ""}${j.totalPnlSol.toFixed(4)} SOL`

                : ""

            }`,

          );

          invalidateClientGet("/api/auto/positions");

          await load();

          await refresh({ silent: true });

          await refreshMode();

        } else {

          setSellMsg(j.error ?? "Sell all failed");

        }

      } finally {

        setSellAllBusy(false);

      }

    },

    [sellAllBusy, data?.open?.length, data?.sessionId, load, refresh, refreshMode],

  );



  const open = data?.open ?? [];

  const closed = data?.closed ?? [];

  const hasAny = open.length > 0 || closed.length > 0;

  const selected = selectedId

    ? [...open, ...closed].find((p) => p.id === selectedId) ?? null

    : null;

  const showPanel = active || hasAny || !!data?.sessionId || !!log?.sessionId;



  if (!showPanel) return null;



  return (

    <section className="card overflow-hidden">

      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">

        <div>

          <h3 className="text-sm font-semibold">Your trades</h3>

          <p className="text-[10px] text-muted">

            This auto-trade session only. Click a row for the chart with your entry marked.

          </p>

        </div>

        {data && (

          <div className="flex flex-wrap items-center gap-2 text-[10px]">

            <span>

              Open <b>{data.stats.openCount}</b>

            </span>

            <span>

              Closed <b>{data.stats.closedCount}</b>

            </span>

            <span className={pnlClass(data.stats.totalPnlSol)}>

              Session PnL{" "}

              <b className="font-mono">

                {data.stats.totalPnlSol >= 0 ? "+" : ""}

                {data.stats.totalPnlSol.toFixed(4)} SOL

              </b>

            </span>

            {open.length > 0 && (

              <>

                <button

                  type="button"

                  disabled={sellAllBusy || !!busyMint}

                  onClick={() => void sellAll("auto")}

                  className="rounded border border-bad/50 px-2 py-1 text-bad hover:bg-bad/10 disabled:opacity-50"

                >

                  {sellAllBusy ? "Selling…" : `Sell all (${open.length})`}

                </button>

                <button

                  type="button"

                  disabled={sellAllBusy || !!busyMint}

                  onClick={() => void sellAll("all")}

                  className="rounded border border-border px-2 py-1 text-muted hover:bg-panel disabled:opacity-50"

                  title="Close every open demo + auto paper position"

                >

                  Sell all holdings

                </button>

              </>

            )}

          </div>

        )}

      </header>

      {sellMsg && (

        <p className="border-b border-border/40 bg-panel/30 px-4 py-1.5 text-[10px] text-muted">{sellMsg}</p>

      )}



      {!hasAny ? (

        <p className="px-4 py-8 text-center text-sm text-muted">

          {active

            ? "No auto trades yet this session — waiting for buys…"

            : "No positions from the last auto session."}

        </p>

      ) : (

        <>

          <div className="grid gap-3 p-3 sm:grid-cols-2">

            <PositionsBox

              title="Open"

              count={open.length}

              empty={active ? "Waiting for buys…" : "No open positions"}

            >

              {open.map((p) => (

                <PositionRow

                  key={p.id}

                  p={p}

                  selected={selected?.id === p.id}

                  onSelect={() => {

                    setSelectedId(p.id);

                    setFocusMint(p.mint);

                  }}

                  onSell={() => void sellPosition(p)}

                  busy={busyMint === p.mint}

                  now={now}

                  uiMode={mode}

                />

              ))}

            </PositionsBox>



            <PositionsBox

              title="Closed"

              count={closed.length}

              empty="No closed trades this session"

            >

              {closed.map((p) => (

                <PositionRow

                  key={p.id}

                  p={p}

                  selected={selected?.id === p.id}

                  onSelect={() => {

                    setSelectedId(p.id);

                    setFocusMint(p.mint);

                  }}

                  now={now}

                  uiMode={mode}

                />

              ))}

            </PositionsBox>

          </div>



          {selected && (

            <div ref={chartRef}>

              <PositionChartPanel

                key={selected.id}

                p={selected}

                scrollToBuy={focusMint === selected.mint}

                onSell={() => void sellPosition(selected)}

                busy={busyMint === selected.mint}

                onClose={() => {

                  setSelectedId(null);

                  setFocusMint(null);

                }}

              />

            </div>

          )}

        </>

      )}

    </section>

  );

}

