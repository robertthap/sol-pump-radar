"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTradingMode } from "@/components/TradingModeProvider";
import { useTradePage } from "@/components/trade/TradePageProvider";
import { TradeSizePicker } from "@/components/TradeSizePicker";
import { actionLabel } from "@/lib/ui/plain-labels";
import { submitDemoTrade, submitLiveTrade } from "@/lib/trade-client";

type Opportunity = {
  mint: string;
  action: string;
  confluenceScore: number;
  qualityScore: number;
  qualityTier: string;
  symbol: string | null;
  vSol: number | null;
  gradScore: number | null;
  rugScore: number | null;
  smartMoneyCount: number;
  insiderSignal: boolean;
  tradable: boolean;
  buyers5m: number;
  bundleRingBuyers: number;
};

function shortMint(m: string) {
  return m.length <= 12 ? m : `${m.slice(0, 4)}…${m.slice(-4)}`;
}

function sortOpps(list: Opportunity[]) {
  return [...list].sort((a, b) => {
    if (a.tradable !== b.tradable) return a.tradable ? -1 : 1;
    if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
    if (a.smartMoneyCount !== b.smartMoneyCount) return b.smartMoneyCount - a.smartMoneyCount;
    return b.confluenceScore - a.confluenceScore;
  });
}

export function TradeClient() {
  const { mode, refresh: refreshMode } = useTradingMode();
  const { opportunities, loading } = useTradePage();
  const opps = useMemo(() => sortOpps(opportunities as Opportunity[]), [opportunities]);
  const [size, setSize] = useState(0.05);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [onlyTradable, setOnlyTradable] = useState(true);

  const shown = onlyTradable ? opps.filter((o) => o.tradable) : opps;

  async function buy(opp: Opportunity) {
    if (busy) return;
    setBusy(opp.mint);
    setMsg(null);
    try {
      if (mode === "demo") {
        const j = await submitDemoTrade({
          mint: opp.mint,
          sizeSol: size,
          side: "buy",
          vSol: opp.vSol ?? undefined,
        });
        setMsg(j.ok ? "Bought" : (j.error ?? "Buy failed"));
        if (j.ok) void refreshMode();
      } else {
        const _label = opp.symbol ?? `${opp.mint.slice(0, 4)}…${opp.mint.slice(-4)}`;
        if (
          !window.confirm(
            `REAL on-chain BUY — this spends real SOL.\n\n` +
              `Buy ${size} SOL of ${_label}?\n` +
              `A ~1% pump fee + slippage apply.`,
          )
        ) {
          setBusy(null);
          return;
        }
        const j = await submitLiveTrade("/api/trade/quick-buy", {
          mint: opp.mint,
          sizeSol: size,
          vSol: opp.vSol ?? undefined,
        });
        setMsg(j.ok ? "Sent" : (j.error ?? "Buy failed"));
        if (j.ok) void refreshMode();
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <TradeSizePicker size={size} onSizeChange={setSize} />
        <label className="ml-2 flex items-center gap-1 text-muted">
          <input
            type="checkbox"
            checked={onlyTradable}
            onChange={(e) => setOnlyTradable(e.target.checked)}
            className="rounded"
          />
          Tradable only
        </label>
        {msg && <span className="text-muted">{msg}</span>}
      </div>

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="table-feed w-full text-xs">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Q</th>
                <th>Signal</th>
                <th className="text-right">Conf</th>
                <th className="hidden text-right sm:table-cell">Insider</th>
                <th className="hidden text-right md:table-cell">Pool</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted">
                    Loading opportunities…
                  </td>
                </tr>
              )}
              {!loading && shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted">
                    No opportunities — tighten filters or wait for new signals.
                  </td>
                </tr>
              )}
              {shown.map((o) => (
                <tr key={o.mint} className="border-t border-border/40">
                  <td>
                    <Link href={`/token/${o.mint}`} className="text-accent hover:underline">
                      {o.symbol ?? shortMint(o.mint)}
                    </Link>
                    {o.tradable && <span className="ml-1 text-[9px] text-ok">OK</span>}
                  </td>
                  <td className="font-mono text-ok">{o.qualityScore}</td>
                  <td>{actionLabel(o.action)}</td>
                  <td className="text-right font-mono">{o.confluenceScore.toFixed(2)}</td>
                  <td className="hidden text-right sm:table-cell">
                    {o.smartMoneyCount > 0 ? (
                      <span className="text-accent">{o.smartMoneyCount} SM</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="hidden text-right font-mono text-muted md:table-cell">
                    {o.vSol != null ? o.vSol.toFixed(1) : "—"}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn btn-buy text-[10px]"
                      disabled={busy === o.mint || !o.tradable}
                      onClick={() => buy(o)}
                    >
                      {busy === o.mint ? "…" : "Buy"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-2 text-[10px] text-muted">
        Ranked by tradable + quality. Refreshes with auto-trade status (no extra polling). Mode:{" "}
        {mode ? mode[0].toUpperCase() + mode.slice(1) : "—"}.
      </p>
    </div>
  );
}
