"use client";

import { useTicker } from "@/components/ticker/TickerProvider";
import type { TickerLogKind } from "@/lib/auto/ticker-snapshot";
import { cleanLogMessage, clock, shortMint, signedSol, toneClass, toneOf } from "@/components/ticker/format";
import { logSourceLabel } from "@/lib/ui/plain-labels";

/**
 * Important events only - what happened to your capital and to the bot.
 * The endpoint has already dropped every `skip`; nothing here filters further.
 * Kind is always a TEXT label; colour is a second channel, never the only one.
 */
const KIND: Record<TickerLogKind, { text: string; cls: string }> = {
  open: { text: "OPENED", cls: "text-accent" },
  close: { text: "CLOSED", cls: "text-fg" },
  tp1: { text: "PARTIAL PROFIT", cls: "text-ok" },
  session: { text: "BOT", cls: "text-warn" },
  halt: { text: "HALT", cls: "text-bad" },
  error: { text: "ERROR", cls: "text-bad" },
};

export function LiveLog() {
  const { data } = useTicker();
  const logs = data?.logs ?? [];

  return (
    <section className="card overflow-hidden" aria-labelledby="log-title">
      <div className="flex min-h-11 items-center justify-between border-b border-border px-3 py-2">
        <h2 id="log-title" className="text-xs font-semibold uppercase tracking-wider text-muted">
          Live log
        </h2>
        <span className="text-xs text-muted">Trades and bot events only</span>
      </div>
      {logs.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted">Nothing yet - opens, closes and bot changes appear here.</p>
      ) : (
        <ol className="m-0 max-h-72 list-none overflow-y-auto p-0 text-xs">
          {logs.map((e) => {
            const k = KIND[e.kind];
            const tone = toneOf(e.pnlSol);
            return (
              <li key={e.id} className="grid grid-cols-[auto_auto_1fr_auto] items-baseline gap-x-3 border-b border-border px-3 py-2 last:border-b-0">
                <time dateTime={e.ts} className="font-mono tabular-nums text-muted">
                  {clock(e.ts)}
                </time>
                <span className={`chip ${k.cls} ${e.kind === "open" ? "border-accent/40" : e.kind === "halt" || e.kind === "error" ? "border-bad/40" : e.kind === "tp1" ? "border-ok/40" : ""}`}>
                  {k.text}
                </span>
                <span className="min-w-0 truncate text-fg">
                  {e.symbol ?? (e.mint ? shortMint(e.mint) : "")}
                  {e.symbol || e.mint ? " · " : ""}
                  {cleanLogMessage(e.message)}
                  <span className="ml-1 text-muted">({logSourceLabel(e.source)})</span>
                </span>
                <span className={`tabular-nums ${toneClass(tone)}`}>{e.pnlSol != null ? signedSol(e.pnlSol, 4) : ""}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
