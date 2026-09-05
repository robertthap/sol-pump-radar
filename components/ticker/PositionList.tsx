"use client";

import { useState } from "react";
import { useTicker } from "@/components/ticker/TickerProvider";
import { PositionRow } from "@/components/ticker/PositionRow";
import { submitSellAll } from "@/lib/trade-client";
import { tradeErrorMessage } from "@/components/ticker/format";

/** Static list of open positions + Sell All. No marquee, no virtualization needed (cap is 5-50). */
export function PositionList() {
  const { data, refresh } = useTicker();
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const positions = data?.positions ?? [];
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

  return (
    <section className="card overflow-hidden" aria-labelledby="positions-title">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h2 id="positions-title" className="text-xs font-semibold uppercase tracking-wider text-muted">
          Open positions <span className="ml-1 rounded bg-panel2 px-1.5 py-0.5 tabular-nums text-fg">{n}</span>
        </h2>
        <button
          type="button"
          onClick={() => void sellAll()}
          disabled={busy || n === 0}
          aria-busy={busy}
          className="btn btn-danger min-h-11 cursor-pointer px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Selling…" : `Sell all${n ? ` (${n})` : ""}`}
        </button>
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

      {n === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted">
          {data?.bot.running ? "No open positions - the bot is watching for entries." : "No open positions."}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {positions.map((p) => (
            <PositionRow key={p.id} p={p} bot={data!.bot} uiMode={data!.status.uiMode} />
          ))}
        </ul>
      )}
    </section>
  );
}
