"use client";

import { useId, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTicker } from "@/components/ticker/TickerProvider";
import { PositionRow } from "@/components/ticker/PositionRow";
import { submitSellAll } from "@/lib/trade-client";
import {
  arrowOf,
  clock,
  closeReasonWords,
  heldFor,
  plainSol,
  shortMint,
  signedPct,
  signedSol,
  toneClass,
  toneOf,
  tradeErrorMessage,
} from "@/components/ticker/format";

/**
 * Open | Closed tabs over one scrolling list. The list viewport is sized to
 * about four and a half rows - the partial fifth row is the cue that it
 * scrolls - so a 14-position session no longer pushes the bot panel and the
 * log off screen. Sell all lives on the Open tab only.
 */
type Tab = "open" | "closed";

export function PositionList() {
  const { data, refresh } = useTicker();
  const [tab, setTab] = useState<Tab>("open");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ids = { open: useId(), closed: useId() };

  const positions = data?.positions ?? [];
  const closed = data?.closedPositions ?? [];
  const n = positions.length;

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
          {tabBtn("open", "Open", n)}
          {tabBtn("closed", "Closed", closed.length)}
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
      <div id={`${ids.open}-panel`} role="tabpanel" aria-labelledby={`${ids.open}-tab`} hidden={tab !== "open"}>
        {n === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">
            {data?.bot.running ? "No open positions - the bot is watching for entries." : "No open positions."}
          </p>
        ) : (
          <ul className="m-0 max-h-[19rem] list-none overflow-y-auto overscroll-contain p-0">
            {positions.map((p) => (
              <PositionRow key={p.id} p={p} bot={data!.bot} uiMode={data!.status.uiMode} />
            ))}
          </ul>
        )}
      </div>

      <div id={`${ids.closed}-panel`} role="tabpanel" aria-labelledby={`${ids.closed}-tab`} hidden={tab !== "closed"}>
        {closed.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">Nothing closed this session yet.</p>
        ) : (
          <ul className="m-0 max-h-[19rem] list-none overflow-y-auto overscroll-contain p-0">
            {closed.map((c) => {
              const tone = toneOf(c.pnlSol);
              const pct = c.pnlSol != null && c.sizeSol > 0 ? c.pnlSol / c.sizeSol : null;
              return (
                <li
                  key={c.id}
                  className={`flex items-center gap-3 border-b border-border border-l-2 px-3 py-2 last:border-b-0 ${
                    tone === "up" ? "border-l-ok/60" : tone === "down" ? "border-l-bad/60" : "border-l-border"
                  }`}
                >
                  <span className="block min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold tracking-tight">{c.symbol ?? shortMint(c.mint)}</span>
                      <span className="text-xs text-muted tabular-nums">{plainSol(c.sizeSol)}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted tabular-nums">
                      {closeReasonWords(c.exitReason)} · held {heldFor(c.openedAt, c.closedAt)} · {c.closedAt ? clock(c.closedAt) : "—"}
                    </span>
                  </span>
                  <span className={`block shrink-0 text-right tabular-nums ${toneClass(tone)}`}>
                    <span className="block font-semibold">
                      <span aria-hidden="true">{arrowOf(tone)} </span>
                      {signedSol(c.pnlSol, 4)}
                    </span>
                    <span className="block text-xs">{signedPct(pct)}</span>
                  </span>
                  <a
                    href={`https://dexscreener.com/solana/${c.mint}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${c.symbol ?? shortMint(c.mint)} in DexScreener (opens in a new tab)`}
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
    </section>
  );
}
