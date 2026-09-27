"use client";

import { useId, useState } from "react";
import { ChevronDown, ExternalLink, LineChart } from "lucide-react";
import type { TickerPosition, TickerResponse } from "@/lib/auto/ticker-snapshot";
import { useTicker } from "@/components/ticker/TickerProvider";
import { CopyMintButton } from "@/components/ticker/CopyMintButton";
import { PositionMiniChart } from "@/components/ticker/PositionMiniChart";
import { age, arrowOf, mcap, plainSol, shortMint, signedPct, signedSol, toneClass, toneOf, tradeErrorMessage } from "@/components/ticker/format";
import { submitDemoTrade, submitLiveTrade } from "@/lib/trade-client";

type Props = {
  p: TickerPosition;
  bot: TickerResponse["bot"];
  uiMode: "demo" | "real" | null;
  marketLive: boolean;
};

/**
 * One open position. The header is a 44px-tall button that expands the row in
 * place; the chevron is decorative (aria-hidden) because the button already has
 * a name and aria-expanded. Sell reuses the existing trade client exactly as
 * /wallet does: demo -> /api/trade/demo, real -> /api/trade/quick-sell. Both are
 * queued for the WORKER to execute; nothing trades from the browser.
 */
export function PositionRow({ p, bot, uiMode, marketLive }: Props) {
  const { now, refresh, seriesForPosition, setTarget, target } = useTicker();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const panelId = useId();

  const tone = toneOf(p.pnlSol);
  const label = p.name?.trim() || p.symbol?.trim() || "Unknown token";
  const identity = p.symbol?.trim() && p.symbol.trim() !== label ? `$${p.symbol.trim()} · ${shortMint(p.mint)}` : shortMint(p.mint);
  const currentMarketData = marketLive && p.currentMcapUsd != null;
  const onChart = target.kind === "position" && target.id === p.id;
  const marketSeries = seriesForPosition(p.id);

  async function sell() {
    if (busy) return;
    if (uiMode !== "real" && p.strategyName && (p.pnlSol == null || p.currentVSol == null)) {
      setErr("Waiting for this strategy's current pool price. Sell is available as soon as the mark is fresh.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Demo sells price off the bonding curve, which is frozen once a coin has
      // graduated. The route accepts a vSol hint, so pass the same mcap-derived
      // current price the worker itself exits at - otherwise graduated positions
      // fail with no_price while Sell all (worker path) succeeds.
      const j =
        uiMode === "real"
          ? await submitLiveTrade("/api/trade/quick-sell", { mint: p.mint, percent: 100 })
          : await submitDemoTrade({ mint: p.mint, side: "sell", vSol: p.currentVSol ?? undefined });
      if (!j.ok) setErr(tradeErrorMessage(j.error));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={`border-b border-border border-l-2 last:border-b-0 ${
        tone === "up" ? "border-l-ok/60" : tone === "down" ? "border-l-bad/60" : "border-l-border"
      }`}
    >
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="relative flex min-h-11 flex-1 cursor-pointer items-center gap-3 overflow-hidden px-3 py-2 text-left hover:bg-panel2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:bg-panel2"
        >
          <PositionMiniChart series={marketSeries} />
          <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
          <span className="block min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-semibold tracking-tight">{label}</span>
              <span className="pill shrink-0 text-[10px] uppercase tracking-wide text-muted">{p.source === "live" ? "Real" : "Paper"}</span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted">{identity} · {plainSol(p.sizeSol)}</span>
            {p.strategyName && <span className="mt-1 block text-xs text-accent">{p.strategyName}{p.added ? " · second tranche added" : ""}{p.researchStatus === "CENSORED" ? " · CENSORED (unpriced)" : ""}</span>}
            <span className="mt-0.5 block text-xs text-muted tabular-nums">
              MC {mcap(p.entryMcapUsd)} <span aria-hidden="true">{"→"}</span>
              <span className="sr-only"> now </span> {mcap(p.currentMcapUsd)} · {age(p.openedAt, now)}
            </span>
          </span>
          <span className={`block shrink-0 text-right tabular-nums ${toneClass(tone)}`}>
            <span className="block font-semibold">
              <span aria-hidden="true">{arrowOf(tone)} </span>
              {signedSol(p.pnlSol, 4)}
            </span>
            <span className="block text-xs">{signedPct(p.pctOfSize)}</span>
          </span>
        </button>
        <CopyMintButton mint={p.mint} tokenLabel={label} className="my-2 px-2" />
        <button
          type="button"
          onClick={() => void sell()}
          disabled={busy}
          aria-busy={busy}
          aria-label={`Sell ${label}`}
          className="btn btn-sell m-2 min-h-11 min-w-[64px] shrink-0 cursor-pointer px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Selling…" : "Sell"}
        </button>
      </div>

      {err && (
        <p className="px-3 pb-2 text-xs text-bad" role="alert">
          {err}
        </p>
      )}

      <div id={panelId} hidden={!open} className="bg-bg/40 px-3 pb-3 pt-1">
        {p.strategyReason && <p className="my-2 text-xs text-accent">Entry: {p.strategyReason}</p>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <Field k="Entry market cap" v={mcap(p.entryMcapUsd)} />
          <Field k="Current market cap" v={mcap(p.currentMcapUsd)} />
          <Field k="Position size" v={plainSol(p.sizeSol)} />
          <Field k="P&L" v={`${signedSol(p.pnlSol, 4)} (${signedPct(p.pctOfSize)})`} cls={toneClass(tone)} />
          <Field k="Open for" v={age(p.openedAt, now)} />
          <Field k="Market feed" v={currentMarketData ? "Live" : "Waiting for current price"} cls={currentMarketData ? "text-ok" : "text-warn"} />
          <Field k="Take-profit / stop-loss" v={`+${(bot.takeProfitPct * 100).toFixed(0)}% / -${(bot.stopLossPct * 100).toFixed(0)}%`} />
          <Field k="Max hold" v={`${bot.maxHoldMinutes} min`} />
          <Field k="Coin address" v={shortMint(p.mint)} title={p.mint} />
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              setTarget(
                onChart
                  ? { kind: "portfolio" }
                  : { kind: "position", id: p.id, mint: p.mint, symbol: p.symbol },
              )
            }
            aria-pressed={onChart}
            className="btn btn-ghost inline-flex min-h-11 cursor-pointer items-center gap-1.5 px-3 text-xs"
          >
            <LineChart size={14} aria-hidden="true" />
            {onChart ? "Showing on chart" : "Show on chart"}
          </button>
          <a
            href={`https://dexscreener.com/solana/${p.mint}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost inline-flex min-h-11 items-center gap-1.5 px-3 text-xs"
          >
            Open in DexScreener <ExternalLink size={14} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </div>
    </li>
  );
}

function Field({ k, v, cls, title }: { k: string; v: string; cls?: string; title?: string }) {
  return (
    <div>
      <dt className="text-muted">{k}</dt>
      <dd className={`font-medium tabular-nums ${cls ?? "text-fg"}`} title={title}>
        {v}
      </dd>
    </div>
  );
}
