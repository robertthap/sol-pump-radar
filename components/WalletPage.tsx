"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useTradingMode } from "@/components/TradingModeProvider";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { SessionWalletBalance } from "@/components/SessionWalletBalance";
import { submitDemoTrade, submitLiveTrade, submitSellAll } from "@/lib/trade-client";
import { useSolPrice, solToAudDisplay } from "@/lib/ui/useSolUsd";

type Position = {
  id: string;
  mint: string;
  symbol: string | null;
  sizeSol: number;
  pnlSol: number | null;
  pctOfSize: number | null;
  status: string;
  action: string | null;
};

type Stats = {
  totalPnlSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  winRate: number | null;
  wins: number;
  losses: number;
  closedCount: number;
  openCount: number;
  equitySol: number;
};

export function WalletPage() {
  const { mode } = useTradingMode();
  const { aud: solAud } = useSolPrice();
  const [rows, setRows] = useState<Position[]>([]);
  const [closed, setClosed] = useState<Position[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sellAllBusy, setSellAllBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/positions?limit=80", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as {
        positions: Position[];
        stats: Stats;
      };
      const all = j.positions ?? [];
      setRows(all.filter((p) => p.status === "open"));
      setClosed(all.filter((p) => p.status === "closed").slice(0, 15));
      setStats(j.stats ?? null);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useVisibleInterval(() => void load(), 10_000, [load]);

  async function sell(mint: string) {
    if (busy) return;
    setBusy(mint);
    try {
      if (mode === "demo") {
        const j = await submitDemoTrade({ mint, side: "sell" });
        if (j.ok) await load();
      } else {
        const j = await submitLiveTrade("/api/trade/quick-sell", { mint, percent: 100 });
        if (j.ok) await load();
      }
    } finally {
      setBusy(null);
    }
  }

  async function sellAll() {
    if (busy || sellAllBusy || rows.length === 0) return;
    if (!window.confirm(`Sell all ${rows.length} open position${rows.length === 1 ? "" : "s"}?`)) return;
    setSellAllBusy(true);
    setInfo(null);
    try {
      const j = await submitSellAll({ scope: "all" });
      if (j.ok) {
        setInfo(
          `Closed ${j.closedCount} position${j.closedCount === 1 ? "" : "s"}${
            j.totalPnlSol != null
              ? ` · PnL ${j.totalPnlSol >= 0 ? "+" : ""}${j.totalPnlSol.toFixed(4)} SOL`
              : ""
          }`,
        );
        await load();
      } else {
        setErr(j.error ?? "Sell all failed");
      }
    } finally {
      setSellAllBusy(false);
    }
  }

  if (err && rows.length === 0 && !stats) return <p className="text-xs text-bad">{err}</p>;

  return (
    <div className="space-y-3">
      <SessionWalletBalance variant="hero" showDemoReset showWalletControls />

      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Win rate</p>
            <p className="font-mono text-lg font-semibold text-ok">
              {stats.winRate != null ? `${(stats.winRate * 100).toFixed(0)}%` : "—"}
            </p>
            <p className="text-[9px] text-muted">
              {stats.wins}W / {stats.losses}L
            </p>
          </div>
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Total PnL</p>
            <p
              className={`font-mono text-lg font-semibold ${
                stats.totalPnlSol >= 0 ? "text-ok" : "text-bad"
              }`}
            >
              {stats.totalPnlSol >= 0 ? "+" : ""}
              {stats.totalPnlSol.toFixed(4)}
            </p>
            <p className="text-[9px] text-muted">SOL · {solToAudDisplay(stats.totalPnlSol, solAud)}</p>
          </div>
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Open</p>
            <p className="font-mono text-lg">{stats.openCount}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted">Open positions</h2>
        {rows.length > 0 && (
          <button
            type="button"
            disabled={sellAllBusy || !!busy}
            onClick={() => void sellAll()}
            className="rounded border border-bad/50 px-3 py-1 text-xs text-bad hover:bg-bad/10 disabled:opacity-50"
          >
            {sellAllBusy ? "Selling all…" : `Sell all (${rows.length})`}
          </button>
        )}
      </div>
      {info && <p className="text-[10px] text-muted">{info}</p>}
      {err && <p className="text-xs text-bad">{err}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No open positions.</p>
      ) : (
        <div className="card overflow-hidden">
          <div className="table-scroll">
            <table className="table-feed w-full text-xs">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Signal</th>
                  <th className="text-right">Size</th>
                  <th className="text-right">PnL</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t border-border/40">
                    <td>
                      <Link href={`/token/${p.mint}`} className="text-accent hover:underline">
                        {p.symbol ?? `${p.mint.slice(0, 4)}…${p.mint.slice(-4)}`}
                      </Link>
                    </td>
                    <td className="text-muted">{p.action?.replace("_", " ") ?? "—"}</td>
                    <td className="text-right font-mono">{p.sizeSol.toFixed(3)} SOL</td>
                    <td
                      className={`text-right font-mono ${
                        p.pnlSol != null && p.pnlSol >= 0
                          ? "text-ok"
                          : p.pnlSol != null
                            ? "text-bad"
                            : "text-muted"
                      }`}
                    >
                      {p.pnlSol != null ? `${p.pnlSol >= 0 ? "+" : ""}${p.pnlSol.toFixed(4)}` : "—"}
                      {p.pctOfSize != null && (
                        <span className="ml-1 text-[9px] text-muted">
                          ({p.pctOfSize >= 0 ? "+" : ""}
                          {(p.pctOfSize * 100).toFixed(0)}%)
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="btn btn-ghost text-[10px] text-bad"
                        disabled={busy === p.mint}
                        onClick={() => sell(p.mint)}
                      >
                        {busy === p.mint ? "…" : "Sell"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {closed.length > 0 && (
        <>
          <h2 className="text-sm font-medium text-muted">Recent closed</h2>
          <div className="card overflow-hidden">
            <div className="table-scroll">
              <table className="table-feed w-full text-xs">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th className="text-right">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((p) => (
                    <tr key={p.id} className="border-t border-border/40">
                      <td>
                        <Link href={`/token/${p.mint}`} className="text-accent hover:underline">
                          {p.symbol ?? p.mint.slice(0, 8)}
                        </Link>
                      </td>
                      <td
                        className={`text-right font-mono ${
                          (p.pnlSol ?? 0) >= 0 ? "text-ok" : "text-bad"
                        }`}
                      >
                        {p.pnlSol != null ? `${p.pnlSol >= 0 ? "+" : ""}${p.pnlSol.toFixed(4)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** @deprecated Use WalletPage */
export const HoldingsPage = WalletPage;
