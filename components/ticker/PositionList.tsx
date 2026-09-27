"use client";

import { useEffect, useId, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTicker } from "@/components/ticker/TickerProvider";
import { CopyMintButton } from "@/components/ticker/CopyMintButton";
import { ClosedPositionRow } from "@/components/ticker/ClosedPositionRow";
import { PositionRow } from "@/components/ticker/PositionRow";
import type { TickerClosedPosition, TickerClosedPositionsResponse } from "@/lib/auto/ticker-snapshot";
import { submitSellAll } from "@/lib/trade-client";
import { clock, shortMint, tradeErrorMessage } from "@/components/ticker/format";

/**
 * Open | Closed tabs over one scrolling list. The list viewport is sized to
 * about four and a half rows - the partial fifth row is the cue that it
 * scrolls - so a 14-position session no longer pushes the bot panel and the
 * log off screen. Sell all lives on the Open tab only.
 */
type Tab = "scouting" | "open" | "closed";

export function PositionList() {
  const { data, refresh } = useTicker();
  const [tab, setTab] = useState<Tab>("open");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [closedHistory, setClosedHistory] = useState<TickerClosedPosition[] | null>(null);
  const [closedSessionId, setClosedSessionId] = useState<string | null>(null);
  const [closedLoading, setClosedLoading] = useState(false);
  const [closedError, setClosedError] = useState<string | null>(null);
  const ids = { scouting: useId(), open: useId(), closed: useId() };

  const positions = data?.positions ?? [];
  const closedPreview = data?.closedPositions ?? [];
  const sessionId = data?.session?.id ?? null;
  const closed = closedSessionId === sessionId && closedHistory ? closedHistory : closedPreview;
  const closedCount = data?.closedPositionCount ?? closedPreview.length;
  const scouting = data?.scouting ?? [];
  const n = positions.length;

  useEffect(() => {
    if (tab !== "closed") return;
    if (!sessionId) {
      setClosedHistory([]);
      setClosedSessionId(null);
      return;
    }

    const controller = new AbortController();
    setClosedLoading(true);
    setClosedError(null);
    void fetch("/api/ticker/closed", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as TickerClosedPositionsResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (body.sessionId !== sessionId) return;
        setClosedHistory(body.closedPositions);
        setClosedSessionId(body.sessionId);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setClosedError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setClosedLoading(false);
      });
    return () => controller.abort();
  }, [tab, sessionId, closedCount]);

  async function sellAll() {
    if (busy || n === 0 || !data) return;
    if (!window.confirm(`Sell all ${n} open position${n === 1 ? "" : "s"}?`)) return;
    setBusy(true);
    setInfo(null);
    setErr(null);
    try {
      const j = await submitSellAll({ scope: "auto", sessionId: data.session?.id });
      if (j.ok) {
        setInfo(
          `Closed ${j.closedCount} position${j.closedCount === 1 ? "" : "s"}${
            j.totalPnlSol != null ? ` · ${j.totalPnlSol >= 0 ? "+" : ""}${j.totalPnlSol.toFixed(4)} SOL` : ""
          }`,
        );
      } else {
        setErr(tradeErrorMessage(j.error));
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const tabBtn = (key: Tab, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      id={`${ids[key]}-tab`}
      aria-selected={tab === key}
      aria-controls={`${ids[key]}-panel`}
      onClick={() => setTab(key)}
      className={`tab min-h-11 cursor-pointer ${tab === key ? "tab-active" : ""}`}
    >
      {label}
      <span className={`pill ml-1 tabular-nums ${tab === key ? "text-accent" : "text-muted"}`}>{count}</span>
    </button>
  );

  return (
    <section className="card overflow-hidden" aria-labelledby="positions-title">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <h2 id="positions-title" className="sr-only">
          Positions
        </h2>
        <div role="tablist" aria-label="Positions" className="flex items-center gap-1">
          {tabBtn("scouting", "Scouting", scouting.length)}
          {tabBtn("open", "Open", n)}
          {tabBtn("closed", "Closed", closedCount)}
        </div>
        {tab === "open" && (
          <button
            type="button"
            onClick={() => void sellAll()}
            disabled={busy || n === 0}
            aria-busy={busy}
            className="btn btn-danger min-h-11 cursor-pointer px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Selling…" : `Sell all${n ? ` (${n})` : ""}`}
          </button>
        )}
      </div>

      {info && (
        <p className="border-b border-border px-3 py-2 text-xs text-ok" role="status">
          {info}
        </p>
      )}
      {err && (
        <p className="border-b border-border px-3 py-2 text-xs text-bad" role="alert">
          {err}
        </p>
      )}

      {/* Both panels stay mounted (hidden) so switching tabs never refetches or loses scroll position. */}
      <div
        id={`${ids.scouting}-panel`}
        role="tabpanel"
        aria-labelledby={`${ids.scouting}-tab`}
        hidden={tab !== "scouting"}
      >
        <p className="border-b border-border px-3 py-2 text-[11px] text-muted">
          Recent strategy candidates and unresolved observations. These are not active Open positions.
        </p>
        {scouting.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">
            {data?.bot.running ? "Scanning the live market for the next strategy entry." : "The bot is not scouting."}
          </p>
        ) : (
          <ul className="m-0 max-h-[19rem] list-none overflow-y-auto overscroll-contain p-0">
            {scouting.map((item) => {
              const label = item.name?.trim() || item.symbol?.trim() || "Unknown token";
              const identity =
                item.symbol?.trim() && item.symbol.trim() !== label
                  ? `$${item.symbol.trim()} · ${shortMint(item.mint)}`
                  : shortMint(item.mint);
              return (
                <li key={item.id} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                  <span className="block min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold">{label}</span>
                      <span className="pill shrink-0 text-[9px] uppercase tracking-wide text-muted">{item.status.replaceAll("_", " ")}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">{identity} · {item.strategy}</span>
                    <span className="mt-0.5 block text-xs text-muted">{item.reason} · {clock(item.ts)}</span>
                  </span>
                  <CopyMintButton mint={item.mint} tokenLabel={label} className="px-2" />
                  <a
                    href={`https://dexscreener.com/solana/${item.mint}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${label} in DexScreener`}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel2 hover:text-fg"
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div id={`${ids.open}-panel`} role="tabpanel" aria-labelledby={`${ids.open}-tab`} hidden={tab !== "open"}>
        {n === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">
            {data?.bot.running ? "No open positions - the bot is watching for entries." : "No open positions."}
          </p>
        ) : (
          <ul className="m-0 max-h-[19rem] list-none overflow-y-auto overscroll-contain p-0">
            {positions.map((p) => (
              <PositionRow
                key={p.id}
                p={p}
                bot={data!.bot}
                uiMode={data!.status.uiMode}
                marketLive={data!.sourceStatus === "live"}
              />
            ))}
          </ul>
        )}
      </div>

      <div id={`${ids.closed}-panel`} role="tabpanel" aria-labelledby={`${ids.closed}-tab`} hidden={tab !== "closed"}>
        <div className="flex min-h-9 items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-muted">
          <span>{closedLoading ? "Loading complete history…" : `All ${closed.length} closed trades this session`}</span>
          <span className="tabular-nums">Newest first</span>
        </div>
        {closedError && (
          <p className="border-b border-border px-3 py-2 text-xs text-warn" role="alert">
            Complete history could not refresh: {closedError}. Showing the available trades.
          </p>
        )}
        {!closedLoading && closed.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">Nothing closed this session yet.</p>
        ) : (
          <ul className="m-0 max-h-[28rem] list-none overflow-y-auto overscroll-contain p-0">
            {closed.map((position) => (
              <ClosedPositionRow key={position.id} position={position} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
