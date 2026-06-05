"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BreakevenHint } from "@/components/BreakevenHint";
import { SessionWalletBalance } from "@/components/SessionWalletBalance";
import { TradeSizePicker } from "@/components/TradeSizePicker";
import { useTradingMode } from "@/components/TradingModeProvider";
import { useTradePage } from "@/components/trade/TradePageProvider";
import { getJson } from "@/lib/ui/client-get";
import {
  loadAutoDailyLossCapEnabled,
  loadAutoDailyLossCapSol,
  saveAutoDailyLossCapEnabled,
  saveAutoDailyLossCapSol,
} from "@/lib/ui/auto-trade-prefs";
import { submitAutoQuickStart, submitAutoStop } from "@/lib/trade-client";

type OverallStats = {
  trades: number;
  winRate: number | null;
  totalPnlSol: number;
};

type Breakdown = {
  allPaper: OverallStats;
  autoTrader: OverallStats;
  shadowLearner: OverallStats;
  manualPaper: OverallStats;
};

const PRESET_TP_SL: Record<
  "balanced" | "conservative" | "aggressive",
  { tp: number; sl: number; help: string }
> = {
  balanced: {
    tp: 0.4,
    sl: 0.15,
    help: "Balanced risk — moderate TP/SL and concurrency",
  },
  conservative: { tp: 0.35, sl: 0.12, help: "Tighter stops, fewer concurrent positions" },
  aggressive: { tp: 0.5, sl: 0.18, help: "Wider take-profit, more concurrent positions" },
};

function fmtStat(s: OverallStats): string {
  const wr = s.winRate != null ? `${(s.winRate * 100).toFixed(0)}% win` : "—";
  const pnl = `${s.totalPnlSol >= 0 ? "+" : ""}${s.totalPnlSol.toFixed(3)} SOL`;
  return `${s.trades} trades · ${wr} · ${pnl}`;
}

export function AutoTradeHero() {
  const { mode: uiMode, refresh: refreshMode } = useTradingMode();
  const { auto: data, refresh: refreshTrade } = useTradePage();
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<"balanced" | "conservative" | "aggressive">("balanced");
  const [msg, setMsg] = useState<string | null>(null);
  const [tradeSize, setTradeSize] = useState(0.05);
  const [dailyCapEnabled, setDailyCapEnabled] = useState(false);
  const [dailyCapSol, setDailyCapSol] = useState("0.3");

  useEffect(() => {
    setDailyCapEnabled(loadAutoDailyLossCapEnabled());
    setDailyCapSol(String(loadAutoDailyLossCapSol()));
  }, []);

  const loadBreakdown = useCallback(async () => {
    const j = await getJson<{ breakdown: Breakdown }>("/api/performance?breakdown=1", 30_000);
    if (j?.breakdown) setBreakdown(j.breakdown);
  }, []);

  const active = data?.active ?? false;
  const halted = data?.cbState === "HALTED";
  const isReal = uiMode === "real";
  const canStart = data && !halted && (!isReal || (data.canRunLive && data.liveExecution === "on"));
  const startBlockedReason =
    !data
      ? null
      : halted
        ? "Trading is paused (circuit breaker)."
        : isReal && !data.canRunLive
          ? "Unlock your wallet on the Wallet page."
          : isReal && data.liveExecution !== "on"
            ? "Live execution is off in server settings."
            : null;
  const sess = data?.session?.stats;
  const sessionSize = data?.session?.params?.sizeSol;
  const pnl = sess?.realizedPnlSol;
  const sessWinRate =
    sess && sess.tradesClosed > 0 ? sess.wins / sess.tradesClosed : null;
  const presetCfg = PRESET_TP_SL[preset];

  async function quickStart() {
    if (busy || !data) return;
    setBusy(true);
    setMsg(null);
    try {
      saveAutoDailyLossCapEnabled(dailyCapEnabled);
      if (dailyCapEnabled) {
        const cap = Number(dailyCapSol);
        if (Number.isFinite(cap) && cap > 0) saveAutoDailyLossCapSol(cap);
      }
      if (isReal) {
        const capNote = dailyCapEnabled ? ` Daily loss cap: ${dailyCapSol} SOL.` : "";
        if (
          !window.confirm(
            `Start REAL auto-trading — the bot places on-chain trades with real SOL.\n\n` +
              `Size: ${tradeSize} SOL per trade · preset: ${preset}.${capNote}\n` +
              `It keeps trading until you press Stop. Continue?`,
          )
        ) {
          setBusy(false);
          return;
        }
      }
      const j = await submitAutoQuickStart({
        preset,
        sizeSol: tradeSize,
        ...(dailyCapEnabled
          ? { maxDailyLossSol: Number(dailyCapSol) || loadAutoDailyLossCapSol() }
          : {}),
      });
      if (!j.ok) setMsg(j.error ?? "start failed");
      else setMsg(`Auto-trader started — ${tradeSize} SOL per trade`);
      await refreshMode();
      await refreshTrade({ silent: true });
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (busy) return;
    setBusy(true);
    try {
      await submitAutoStop("user_one_click_stop");
      setMsg(null);
      await refreshMode();
      await refreshTrade({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`card overflow-hidden ${active ? "ring-2 ring-ok/50" : ""}`}>
      <SessionWalletBalance variant="compact" />
      <div className="flex flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Auto-trade</h2>
          <p className="mt-1 text-sm text-muted">
            {!data
              ? "Loading status…"
              : active
                ? "Bot is running — only strong buys that pass safety checks."
                : isReal
                  ? "Real wallet required."
                  : "Demo mode — play money, no crypto needed."}
          </p>
          {!active && <p className="mt-1 text-[10px] text-muted">{presetCfg.help}</p>}
          {active && sessionSize != null && (
            <p className="mt-1 text-[10px] text-muted">
              Session size: <b className="font-mono">{sessionSize.toFixed(3)} SOL</b> per trade
            </p>
          )}
          {!active && (
            <BreakevenHint takeProfitPct={presetCfg.tp} stopLossPct={presetCfg.sl} className="mt-1" />
          )}
          {active && pnl != null && (
            <p className="mt-2 font-mono text-sm">
              This session:{" "}
              <span className={pnl >= 0 ? "text-ok" : "text-bad"}>
                {pnl >= 0 ? "+" : ""}
                {pnl.toFixed(4)} SOL
              </span>
              {sessWinRate != null && (
                <span className="ml-2 text-muted">
                  · {(sessWinRate * 100).toFixed(0)}% win ({sess?.wins}/{sess?.tradesClosed})
                </span>
              )}
            </p>
          )}
          {!active && !breakdownOpen && (
            <button
              type="button"
              className="mt-2 text-[10px] text-accent hover:underline"
              onClick={() => {
                setBreakdownOpen(true);
                void loadBreakdown();
              }}
            >
              Show 7-day stats
            </button>
          )}
          {breakdown && !active && breakdownOpen && (
            <div className="mt-2 space-y-0.5 text-[10px] text-muted">
              <p>
                <span className="text-fg">Auto-trader (7d):</span> {fmtStat(breakdown.autoTrader)}
              </p>
              <p>
                <span className="text-fg">Manual demo (7d):</span> {fmtStat(breakdown.manualPaper)}
              </p>
              <p>
                <span className="text-fg">Background learner (7d):</span>{" "}
                {fmtStat(breakdown.shadowLearner)}
              </p>
              <p className="text-[9px]">
                All paper combined: {fmtStat(breakdown.allPaper)} — includes background bots
              </p>
            </div>
          )}
          {halted && <p className="mt-1 text-xs text-warn">Trading paused — resume before starting.</p>}
          {startBlockedReason && !active && (
            <p className="mt-1 text-xs text-warn">{startBlockedReason}</p>
          )}
          {msg && <p className="mt-1 text-xs text-muted">{msg}</p>}
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          {!active && (
            <>
              <div className="flex gap-1 text-[10px]">
                {(["balanced", "conservative", "aggressive"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    title={PRESET_TP_SL[p].help}
                    onClick={() => setPreset(p)}
                    className={`rounded border px-2 py-1 capitalize ${
                      preset === p ? "border-accent text-accent" : "border-border text-muted"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <TradeSizePicker size={tradeSize} onSizeChange={setTradeSize} className="justify-end" />
              <label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted">
                <input
                  type="checkbox"
                  checked={dailyCapEnabled}
                  onChange={(e) => setDailyCapEnabled(e.target.checked)}
                  className="rounded"
                />
                Custom daily loss cap
                {dailyCapEnabled && (
                  <>
                    <input
                      type="number"
                      min={0.05}
                      max={100}
                      step={0.05}
                      value={dailyCapSol}
                      onChange={(e) => setDailyCapSol(e.target.value)}
                      className="w-16 rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-xs"
                    />
                    <span>SOL</span>
                  </>
                )}
                {!dailyCapEnabled && (
                  <span className="text-[9px]">
                    (uses preset default ·{" "}
                    <Link href="/analytics" className="text-accent hover:underline">
                      live daily cap
                    </Link>
                    )
                  </span>
                )}
              </label>
            </>
          )}
          {active ? (
            <button type="button" className="btn btn-danger px-8 py-3 text-base" onClick={stop} disabled={busy}>
              {busy ? "Stopping…" : "Stop auto-trade"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-buy px-10 py-3 text-base font-semibold shadow-lg shadow-ok/20"
              onClick={quickStart}
              disabled={busy || !data || !canStart}
              title={startBlockedReason ?? undefined}
            >
              {busy ? "Starting…" : "Start auto-trade"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
