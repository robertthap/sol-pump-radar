"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ResetModal } from "./ResetModal";

type Portfolio = {
  sessionId: string;
  balanceSol: number;
  equitySol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  peakEquitySol: number;
  totalTrades: number;
  wins: number;
  losses: number;
  drawdownSol: number;
  drawdownPct: number;
  winRate: number | null;
  todayLossSol: number;
  updatedAt: string;
};

type OpenPosition = {
  id: string;
  mint: string;
  symbol: string | null;
  side: string;
  state: string;
  entryPrice: number;
  currentPrice: number | null;
  quantity: number;
  notionalSol: number;
  unrealizedPnlSol: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
};

type ClosedRow = {
  id: string;
  session_id: string;
  mint: string;
  symbol: string | null;
  side: string;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  notional_sol: number;
  realized_pnl_sol: number | null;
  close_reason: string | null;
  opened_at: string;
  closed_at: string | null;
};

function fmtSol(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "" : "";
  return `${sign}${n.toFixed(digits)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function shortMint(m: string): string {
  return m.length > 12 ? `${m.slice(0, 6)}…${m.slice(-4)}` : m;
}

export function PaperDashboard() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [open, setOpen] = useState<OpenPosition[]>([]);
  const [closed, setClosed] = useState<ClosedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [snapR, histR] = await Promise.all([
        fetch("/api/paper/snapshot", { cache: "no-store" }),
        fetch("/api/paper/history?limit=30", { cache: "no-store" }),
      ]);
      if (!snapR.ok) {
        const { error: msg } = (await snapR.json()) as { error?: string };
        setError(msg ?? `snapshot HTTP ${snapR.status}`);
        setPortfolio(null);
        return;
      }
      const snap = (await snapR.json()) as { portfolio: Portfolio; openPositions: OpenPosition[] };
      setPortfolio(snap.portfolio);
      setOpen(snap.openPositions);
      if (histR.ok) {
        const hist = (await histR.json()) as { closed: ClosedRow[] };
        setClosed(hist.closed);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const submitReset = useCallback(
    async (reason: string, startSol?: number) => {
      setResetPending(true);
      try {
        const r = await fetch("/api/paper/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason, startSol }),
        });
        if (!r.ok) throw new Error(`reset HTTP ${r.status}`);
        setResetOpen(false);
        setTimeout(() => void load(), 1500);
      } catch (e) {
        alert(String(e));
      } finally {
        setResetPending(false);
      }
    },
    [load],
  );

  const totalEquity = useMemo(() => {
    if (!portfolio) return 0;
    return portfolio.balanceSol + portfolio.unrealizedPnlSol;
  }, [portfolio]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
            <span className="rounded bg-emerald-700/20 px-2 py-0.5 font-mono text-emerald-700">
              MODE: PAPER
            </span>
            {portfolio && (
              <span className="font-mono text-muted">
                session #{portfolio.sessionId}
              </span>
            )}
          </div>
          <h1 className="mt-1 text-2xl font-semibold">Paper portfolio</h1>
        </div>
        <button
          type="button"
          className="rounded border border-bad/40 bg-bad/10 px-3 py-1.5 text-sm text-bad hover:bg-bad/20"
          onClick={() => setResetOpen(true)}
        >
          Reset portfolio
        </button>
      </header>

      {error && (
        <div className="rounded border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
          {error}
          <div className="mt-1 text-xs opacity-70">
            Run <code>pnpm worker</code> in a second terminal to boot the paper engine.
          </div>
        </div>
      )}

      {portfolio && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Balance" value={`${portfolio.balanceSol.toFixed(4)} SOL`} />
            <Stat
              label="Equity"
              value={`${totalEquity.toFixed(4)} SOL`}
              hint={`peak ${portfolio.peakEquitySol.toFixed(4)}`}
            />
            <Stat
              label="Realized PnL"
              value={fmtSol(portfolio.realizedPnlSol)}
              tone={portfolio.realizedPnlSol > 0 ? "good" : portfolio.realizedPnlSol < 0 ? "bad" : "neutral"}
              hint="all closed"
            />
            <Stat
              label="Unrealized PnL"
              value={fmtSol(portfolio.unrealizedPnlSol)}
              tone={portfolio.unrealizedPnlSol > 0 ? "good" : portfolio.unrealizedPnlSol < 0 ? "bad" : "neutral"}
              hint={`${open.length} open`}
            />
            <Stat
              label="Win rate"
              value={fmtPct(portfolio.winRate)}
              hint={`${portfolio.wins}W / ${portfolio.losses}L of ${portfolio.totalTrades}`}
            />
            <Stat label="Drawdown" value={fmtPct(portfolio.drawdownPct)} hint={`${portfolio.drawdownSol.toFixed(4)} SOL`} />
            <Stat label="Today loss" value={`-${portfolio.todayLossSol.toFixed(4)} SOL`} tone="bad" />
            <Stat label="Total trades" value={String(portfolio.totalTrades)} />
          </section>

          <section className="rounded border border-border bg-panel/50">
            <header className="border-b border-border px-3 py-2 text-sm font-medium">
              Open positions ({open.length})
            </header>
            {open.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted">
                No open positions. Start an auto-session at <a className="underline" href="/trade">/trade</a> to see fills here.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-3 py-2">Mint</th>
                    <th className="px-3 py-2">Side</th>
                    <th className="px-3 py-2 text-right">Notional</th>
                    <th className="px-3 py-2 text-right">Entry</th>
                    <th className="px-3 py-2 text-right">Current</th>
                    <th className="px-3 py-2 text-right">Unrealized</th>
                    <th className="px-3 py-2 text-right">TP / SL</th>
                    <th className="px-3 py-2 text-right">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((p) => {
                    const pnlTone =
                      (p.unrealizedPnlSol ?? 0) > 0
                        ? "text-good"
                        : (p.unrealizedPnlSol ?? 0) < 0
                          ? "text-bad"
                          : "text-fg";
                    return (
                      <tr key={p.id} className="border-t border-border/60">
                        <td className="px-3 py-2 font-mono text-xs">
                          {p.symbol ?? shortMint(p.mint)}
                        </td>
                        <td className="px-3 py-2">{p.side}</td>
                        <td className="px-3 py-2 text-right">{p.notionalSol.toFixed(4)}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{p.entryPrice.toFixed(6)}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {p.currentPrice != null ? p.currentPrice.toFixed(6) : "—"}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono ${pnlTone}`}>
                          {fmtSol(p.unrealizedPnlSol)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {p.takeProfit ? p.takeProfit.toFixed(6) : "—"} / {p.stopLoss ? p.stopLoss.toFixed(6) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted">
                          {new Date(p.openedAt).toLocaleTimeString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded border border-border bg-panel/50">
            <header className="border-b border-border px-3 py-2 text-sm font-medium">
              Recent closes ({closed.length})
            </header>
            {closed.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted">No closed positions yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-3 py-2">Closed</th>
                    <th className="px-3 py-2">Mint</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2 text-right">Notional</th>
                    <th className="px-3 py-2 text-right">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((r) => {
                    const pnl = r.realized_pnl_sol ?? 0;
                    const tone = pnl > 0 ? "text-good" : pnl < 0 ? "text-bad" : "text-fg";
                    return (
                      <tr key={r.id} className="border-t border-border/60">
                        <td className="px-3 py-2 text-xs text-muted">
                          {r.closed_at ? new Date(r.closed_at).toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {r.symbol ?? shortMint(r.mint)}
                        </td>
                        <td className="px-3 py-2 text-xs">{r.close_reason ?? "—"}</td>
                        <td className="px-3 py-2 text-right">{r.notional_sol.toFixed(4)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${tone}`}>{fmtSol(pnl)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      <ResetModal
        open={resetOpen}
        pending={resetPending}
        onCancel={() => setResetOpen(false)}
        onConfirm={submitReset}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad" | "neutral";
}) {
  const toneClass = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-fg";
  return (
    <div className="rounded border border-border bg-panel/40 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 font-mono text-lg ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted">{hint}</div>}
    </div>
  );
}
