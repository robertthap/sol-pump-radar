"use client";

import { RefreshCw, X } from "lucide-react";
import { useTicker } from "@/components/ticker/TickerProvider";
import { PnlSparkline } from "@/components/ticker/PnlSparkline";
import { arrowOf, aud, plainSol, signedPct, signedSol, toneClass, toneOf } from "@/components/ticker/format";

/**
 * The answer to "how much am I in and am I up or down", in one glance.
 *
 * Big number = total P&L this session (realized + unrealized). The secondary
 * line separates the two so the percentage is unambiguous: it is the return on
 * what is currently open. Every figure carries sign + arrow, never colour only.
 * Numerics use tabular figures and reserved widths so 1 s updates do not jitter.
 * The card's top edge and a faint glow behind the number take the P&L tone -
 * information, not decoration.
 */
const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  live: { text: "LIVE", cls: "text-ok" },
  stale: { text: "STALE", cls: "text-warn" },
  no_session: { text: "NO SESSION", cls: "text-muted" },
  stopped: { text: "STOPPED", cls: "text-muted" },
  halted: { text: "HALTED", cls: "text-bad" },
  offline: { text: "OFFLINE", cls: "text-bad" },
  error: { text: "ERROR", cls: "text-bad" },
};

export function PnlHero() {
  const { data, error, lastOkAt, now, target, setTarget, series, refresh, statusSentence } = useTicker();

  const ageSec = lastOkAt ? Math.max(0, Math.floor((now - lastOkAt) / 1000)) : null;
  const status = error ? (data ? "stale" : "error") : (data?.sourceStatus ?? "loading");
  const s = STATUS_LABEL[status] ?? { text: "LOADING", cls: "text-muted" };
  const current = status === "live";
  const dim = !current && data != null;

  const p = data?.portfolio;
  const totalTone = toneOf(p?.totalPnlSol);
  const openTone = toneOf(p?.unrealizedPnlSol);
  const edge = totalTone === "up" ? "bg-ok" : totalTone === "down" ? "bg-bad" : "bg-border";
  const glow =
    totalTone === "up"
      ? "bg-[radial-gradient(ellipse_at_left_top,rgb(34_197_94/0.10),transparent_60%)]"
      : totalTone === "down"
        ? "bg-[radial-gradient(ellipse_at_left_top,rgb(244_84_84/0.10),transparent_60%)]"
        : "";

  const seriesLabel = target.kind === "portfolio" ? "Portfolio P&L" : `${target.symbol ?? target.mint.slice(0, 6)} P&L`;

  return (
    <section className={`card relative overflow-hidden p-4 sm:p-5 ${glow}`} aria-labelledby="pnl-hero-title">
      <div aria-hidden="true" className={`absolute inset-x-0 top-0 h-0.5 ${edge}`} />

      {/* One throttled status region; the fast numbers below are deliberately NOT live regions. */}
      <p className="sr-only" role="status" aria-atomic="true">
        {statusSentence}
      </p>

      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 id="pnl-hero-title" className="text-xs font-semibold uppercase tracking-wider text-muted">
          Total P&amp;L
        </h1>
        <div className="flex items-center gap-2 text-xs">
          <span className={`pill font-semibold ${current ? "badge-up" : s.cls}`}>
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${current ? "bg-ok motion-safe:animate-pulse" : status === "stale" ? "bg-warn" : status === "halted" || status === "offline" || status === "error" ? "bg-bad" : "bg-muted"}`}
            />
            {status === "stale" || (error && data) ? "⚠ " : ""}
            {s.text}
          </span>
          {ageSec != null && (
            <span className="text-muted tabular-nums" aria-label={`updated ${ageSec} seconds ago`}>
              Updated {ageSec}s ago
            </span>
          )}
          {(error || status === "stale") && (
            <button
              type="button"
              onClick={() => void refresh()}
              className="btn btn-ghost inline-flex min-h-8 items-center gap-1 px-2 text-xs"
              aria-label="Retry now"
            >
              <RefreshCw size={14} aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad" role="alert">
          Could not refresh: {error}. Showing the last value from {ageSec ?? "?"}s ago.
        </p>
      )}

      <div className={`grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] ${dim ? "opacity-60" : ""}`}>
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={`min-w-[11ch] text-5xl font-semibold leading-none tracking-tight tabular-nums sm:text-6xl ${toneClass(totalTone)}`}
              data-testid="hero-total"
            >
              {/* 4 decimals everywhere P&L is shown, so the hero never disagrees with a sum of the rows by rounding. */}
              {p ? signedSol(p.totalPnlSol, 4) : "—"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted tabular-nums">{p ? aud(p.totalPnlSol, data!.solAud) : "—"}</p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div>
              <dt className="text-muted">Open</dt>
              <dd className={`font-medium tabular-nums ${toneClass(openTone)}`}>
                <span aria-hidden="true">{arrowOf(openTone)} </span>
                {p ? signedSol(p.unrealizedPnlSol, 4) : "—"}
                <span className="ml-1">{p ? `(${signedPct(p.unrealizedPct)})` : ""}</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">Realized (this session)</dt>
              <dd className={`font-medium tabular-nums ${toneClass(toneOf(p?.realizedPnlSol))}`}>{p ? signedSol(p.realizedPnlSol, 4) : "—"}</dd>
            </div>
          </dl>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
            {[
              ["Invested", p ? plainSol(p.investedSol) : "—"],
              ["Value", p ? plainSol(p.currentValueSol) : "—"],
              ["Available", p?.availableSol != null ? plainSol(p.availableSol) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="card-2 px-3 py-2">
                <dt className="text-[10px] uppercase tracking-wider text-muted">{k}</dt>
                <dd className="mt-0.5 font-semibold tabular-nums text-fg">{v}</dd>
              </div>
            ))}
          </dl>
          {p?.unpricedCount ? (
            <p className="mt-2 text-xs text-warn">
              {p.unpricedCount} position{p.unpricedCount === 1 ? "" : "s"} not yet priced
            </p>
          ) : null}
        </div>

        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1" role="group" aria-label="Chart series">
              <button
                type="button"
                onClick={() => setTarget({ kind: "portfolio" })}
                aria-pressed={target.kind === "portfolio"}
                className={`chip min-h-11 cursor-pointer px-3 ${target.kind === "portfolio" ? "border-accent/60 text-accent" : "text-muted"}`}
              >
                Portfolio
              </button>
              {target.kind === "position" && (
                <span className="chip inline-flex min-h-11 items-center gap-1 border-accent/60 pl-3 pr-1 text-accent">
                  {target.symbol ?? target.mint.slice(0, 6)}
                  <button
                    type="button"
                    onClick={() => setTarget({ kind: "portfolio" })}
                    aria-label={`Stop showing ${target.symbol ?? target.mint.slice(0, 6)} on the chart`}
                    className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded hover:bg-panel2"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              )}
            </div>
            <span className="text-muted">{seriesLabel} · Live · this session · last 10 min</span>
          </div>
          <PnlSparkline series={series} label={seriesLabel} />
        </div>
      </div>
    </section>
  );
}
