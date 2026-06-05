"use client";
import { useCallback, useEffect, useState } from "react";
import { useSignalsStream } from "@/lib/ui/useSignalsStream";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { shortAddr, relTime, fmtClock, fmtSol } from "@/lib/ui/format";
import { setSelectedMint } from "@/lib/ui/store";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { actionLabel } from "@/lib/ui/plain-labels";
import { tierClass } from "@/lib/signals/quality";
import {
  engineBadgeClass,
  intelligenceSignalClass,
  intelligenceSignalLabel,
  stateChipClass,
} from "@/lib/ui/intelligence-labels";

type Signal = {
  id: string;
  ts: string;
  mint: string;
  action: string;
  confluenceScore: number;
  gradScore: number | null;
  rugScore: number | null;
  insiderScore: number | null;
  washScore: number | null;
  reasonHuman: string;
  executed: string;
  symbol: string | null;
  name: string | null;
  vAtSignal: number | null;
  vNow: number | null;
  changePct: number | null;
  rugLabel: string | null;
  smartMoneyCount: number;
  insiderSignal: boolean;
  qualityScore: number;
  qualityTier: "hot" | "good" | "fair" | "weak" | "avoid";
  tradable: boolean;
  autoReady: boolean;
  executorReason: string | null;
  qualityTags: string[];
  intelligenceCommit: boolean;
  intelligenceEngine: "A" | "B" | null;
  intelligenceSignal: string | null;
  intelligenceState: string | null;
  intelligenceRankPct: number | null;
  autoTradeAllowed: boolean;
  missType: string | null;
  recommendedAt: string | null;
  missedProfitSol: number | null;
  missedProfitPct: number | null;
};

type Summary = {
  total: number;
  buyStrong: number;
  hot: number;
  tradable: number;
  autoReady: number;
  avgQualityScore: number | null;
  withInsider: number;
  signalWinRate: number | null;
  signalTracked: number;
  signalAvgChangePct: number | null;
  paperWinRate: number | null;
  paperTrades: number;
  paperPnlSol: number;
  autoWinRate: number | null;
  autoTrades: number;
  autoPnlSol: number;
  intelligenceCommits?: number;
  missedProfitSol?: number;
  missedBuySignals?: number;
};

const ACTION_FILTERS = [
  { id: "all", label: "All" },
  { id: "auto_ready", label: "Auto-ready" },
  { id: "tradable", label: "Tradable" },
  { id: "hot", label: "Hot" },
  { id: "BUY_STRONG", label: "Strong" },
  { id: "WATCH", label: "Watch" },
  { id: "engine_b", label: "Continuation" },
  { id: "intelligence", label: "Intelligence" },
  { id: "auto_gate", label: "Auto gate" },
] as const;

function executedLabel(ex: string, reason: string | null) {
  if (ex === "pending") return { text: "Pending", cls: "text-muted" };
  if (ex === "skipped") {
    const short =
      reason?.includes("auto_trade") ? "Auto blocked" : reason?.replace(/^auto:/, "") ?? "skip";
    return { text: short, cls: "text-warn" };
  }
  if (ex.startsWith("executed")) return { text: "Traded", cls: "text-ok" };
  return { text: ex, cls: "text-muted" };
}

function actionStyle(a: string) {
  if (a === "BUY_STRONG") return "border-ok/60 bg-ok/15 text-ok";
  if (a === "BUY_MODERATE") return "border-ok/40 bg-ok/10 text-ok";
  if (a === "WATCH") return "border-accent/40 bg-accent/10 text-accent";
  if (a === "AVOID") return "border-bad/40 bg-bad/10 text-bad";
  return "border-border text-muted";
}

function changeCls(p: number | null) {
  if (p == null) return "text-muted";
  if (p > 5) return "text-ok";
  if (p < -5) return "text-bad";
  return "text-muted";
}

function missedCls(sol: number | null) {
  if (sol == null) return "text-muted";
  if (sol > 0.002) return "text-ok";
  if (sol < -0.002) return "text-bad";
  return "text-muted";
}

function pct(n: number | null) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function ModuleBar({ label, value, invert }: { label: string; value: number | null; invert?: boolean }) {
  if (value == null) return null;
  const v = Math.max(0, Math.min(1, value));
  const good = invert ? v < 0.35 : v > 0.55;
  return (
    <span className="inline-flex items-center gap-0.5" title={`${label} ${v.toFixed(2)}`}>
      <span className="text-[8px] text-muted">{label}</span>
      <span
        className={`inline-block h-1 w-6 rounded-full ${good ? "bg-ok/60" : "bg-muted/40"}`}
        style={{ width: `${Math.round(v * 24)}px`, maxWidth: 24 }}
      />
    </span>
  );
}

export function SignalDashboard({
  compact,
  pollMs,
}: {
  compact?: boolean;
  /** Override poll interval (ms). Terminal uses slower polls. */
  pollMs?: number;
}) {
  const pathname = usePathname();
  const isTerminal = pathname === "/mission";
  const [signals, setSignals] = useState<Signal[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [hours, setHours] = useState(compact ? 12 : 24);
  const [filter, setFilter] = useState<string>("tradable");
  const [now, setNow] = useState(0);

  const useStream =
    filter === "intelligence" || filter === "auto_gate" || filter === "auto_ready";
  const stream = useSignalsStream({
    intelligenceOnly: filter === "intelligence",
    autoGateOnly: filter === "auto_gate",
  });

  useEffect(() => {
    if (!useStream || !stream.payload?.signals) return;
    setSignals(stream.payload.signals as Signal[]);
  }, [useStream, stream.payload]);

  const load = useCallback(async () => {
    if (useStream) return;
    try {
      const params = new URLSearchParams({
        hours: String(hours),
        limit: compact ? "60" : "200",
        sortBy: filter === "hot" || filter === "tradable" || filter === "auto_ready" ? "score" : "time",
      });
      if (compact) params.set("lite", "1");
      if (filter === "tradable") params.set("tradableOnly", "1");
      else if (filter === "auto_ready") params.set("autoReadyOnly", "1");
      else if (filter === "hot") params.set("minScore", "82");
      else if (filter === "intelligence") params.set("intelligenceOnly", "1");
      else if (filter === "auto_gate") params.set("autoGateOnly", "1");
      else if (filter === "engine_b") params.set("engineB", "1");
      else if (filter !== "all") params.set("action", filter);

      const r = await fetch(`/api/signals?${params}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { signals: Signal[]; summary: Summary };
      setSignals(j.signals ?? []);
      setSummary(j.summary ?? null);
    } catch {
      /* ignore */
    }
  }, [hours, filter, compact, useStream]);

  const interval = pollMs ?? (compact ? 12_000 : 8_000);
  useVisibleInterval(load, interval, [load]);
  useVisibleInterval(() => setNow(Date.now()), 2_000, []);

  const pickMint = (mint: string) => {
    setSelectedMint(mint);
    if (!isTerminal) return;
  };

  return (
    <div className={`space-y-3 ${compact ? "signal-dashboard-compact" : ""}`}>
      {summary && !compact && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Tradable now</p>
            <p className="font-mono text-lg font-semibold text-ok">{summary.tradable}</p>
            <p className="text-[9px] text-muted">
              {summary.hot} hot · {summary.autoReady} auto-ready
              {(summary.intelligenceCommits ?? 0) > 0
                ? ` · ${summary.intelligenceCommits} intel`
                : ""}
            </p>
          </div>
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Signal win</p>
            <p className="font-mono text-lg font-semibold text-ok">{pct(summary.signalWinRate)}</p>
            <p className="text-[9px] text-muted">{summary.signalTracked} buys tracked</p>
          </div>
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Auto-trade PnL</p>
            <p
              className={`font-mono text-lg font-semibold ${
                summary.autoPnlSol >= 0 ? "text-ok" : "text-bad"
              }`}
            >
              {summary.autoPnlSol >= 0 ? "+" : ""}
              {summary.autoPnlSol.toFixed(3)}
            </p>
            <p className="text-[9px] text-muted">
              {summary.autoTrades > 0 && summary.autoWinRate != null
                ? `${(summary.autoWinRate * 100).toFixed(0)}% win (${summary.autoTrades})`
                : "filtered entries"}
            </p>
          </div>
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">All paper</p>
            <p className="font-mono text-lg font-semibold">{pct(summary.paperWinRate)}</p>
            <p className="text-[9px] text-muted">{summary.paperTrades} closed</p>
          </div>
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Missed (untraded)</p>
            <p
              className={`font-mono text-lg font-semibold ${
                (summary.missedProfitSol ?? 0) >= 0 ? "text-warn" : "text-ok"
              }`}
            >
              {(summary.missedProfitSol ?? 0) >= 0 ? "+" : ""}
              {(summary.missedProfitSol ?? 0).toFixed(3)}
            </p>
            <p className="text-[9px] text-muted">
              {summary.missedBuySignals ?? 0} buy signals · paper size
            </p>
          </div>
          <div className="card p-2 text-center">
            <p className="text-[9px] uppercase text-muted">Smart wallets</p>
            <p className="font-mono text-lg font-semibold text-accent">{summary.withInsider}</p>
            <p className="text-[9px] text-muted">insider flow</p>
          </div>
        </div>
      )}

      {summary && compact && (
        <div className="flex flex-wrap gap-2 text-[10px]">
          <span className="pill border-ok/40 text-ok">{summary.tradable} tradable</span>
          <span className="pill border-accent/40 text-accent">{summary.autoReady} auto-ready</span>
          <span className="pill text-muted">{summary.hot} hot</span>
          {summary.autoTrades > 0 && (
            <span className={`pill ${summary.autoPnlSol >= 0 ? "text-ok" : "text-bad"}`}>
              auto {summary.autoPnlSol >= 0 ? "+" : ""}
              {summary.autoPnlSol.toFixed(3)} SOL
            </span>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="text-[10px] text-muted">
            Buy @ = system recommendation time · Missed = paper PnL since signal if you did not enter
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="rounded border border-border bg-panel px-2 py-1 text-[10px]"
            >
              <option value={6}>6h</option>
              <option value={12}>12h</option>
              <option value={24}>24h</option>
              <option value={48}>48h</option>
            </select>
            <div className="flex flex-wrap gap-1">
              {ACTION_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`rounded border px-2 py-0.5 text-[10px] ${
                    filter === f.id ? "border-accent text-accent" : "border-border text-muted"
                  }`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div
          className={`table-scroll table-scroll-wide ${compact ? "max-h-[520px]" : "max-h-[640px]"} overflow-y-auto`}
        >
          <table className="table-feed w-full text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <th>When</th>
                {!compact && <th>Buy @</th>}
                <th>Q</th>
                <th>Signal</th>
                {!compact && <th>Intel</th>}
                <th>Status</th>
                <th>Token</th>
                {!compact && <th>Modules</th>}
                <th className="text-right">Conf</th>
                <th className="text-right">Curve Δ</th>
                <th className="text-right">Missed</th>
              </tr>
            </thead>
            <tbody>
              {signals.length === 0 && (
                <tr>
                  <td colSpan={compact ? 8 : 11} className="px-3 py-8 text-center text-muted">
                    No matching signals — try All or wait for worker data.
                  </td>
                </tr>
              )}
              {signals.map((s) => {
                const ex = executedLabel(s.executed, s.executorReason);
                return (
                <tr
                  key={s.id}
                  className={`row-hover row-clickable border-t border-border/40 ${
                    s.autoReady ? "bg-ok/[0.06]" : s.tradable ? "bg-ok/[0.03]" : ""
                  }`}
                  onClick={() => pickMint(s.mint)}
                >
                  <td
                    className="whitespace-nowrap font-mono text-[10px] text-muted"
                    title={s.recommendedAt ? `Buy @ ${s.recommendedAt}` : s.ts}
                  >
                    {now > 0 ? relTime(s.ts, now) : "…"}
                    {compact && s.recommendedAt && now > 0 && (
                      <span className="block text-[9px] text-foreground">
                        buy {fmtClock(s.recommendedAt)}
                      </span>
                    )}
                  </td>
                  {!compact && (
                    <td
                      className="whitespace-nowrap font-mono text-[10px]"
                      title={
                        s.recommendedAt
                          ? `Buy recommended ${s.recommendedAt}`
                          : "Not a buy recommendation"
                      }
                    >
                      {s.recommendedAt && now > 0 ? (
                        <>
                          <span className="text-foreground">{fmtClock(s.recommendedAt, true)}</span>
                          <span className="ml-1 text-muted">{relTime(s.recommendedAt, now)}</span>
                        </>
                      ) : s.recommendedAt ? (
                        <span className="text-muted">…</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  )}
                  <td>
                    <span
                      className={`pill font-mono text-[10px] ${tierClass(s.qualityTier)}`}
                      title={s.qualityTags.join(", ")}
                    >
                      {s.qualityScore}
                    </span>
                  </td>
                  <td>
                    <span className={`pill text-[10px] ${actionStyle(s.action)}`} title={s.reasonHuman}>
                      {actionLabel(s.action)}
                    </span>
                    {s.tradable && (
                      <span className="ml-1 text-[8px] uppercase text-ok">✓</span>
                    )}
                    {s.autoTradeAllowed && (
                      <span className="ml-1 text-[8px] uppercase text-accent">GATE</span>
                    )}
                  </td>
                  {!compact && (
                    <td className="text-[10px]">
                      {s.intelligenceCommit ? (
                        <span className={`pill ${engineBadgeClass(s.intelligenceEngine ?? "B")}`}>
                          {s.intelligenceEngine ?? "?"}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                      {s.intelligenceSignal && (
                        <span
                          className={`ml-1 pill ${intelligenceSignalClass(s.intelligenceSignal as "WATCH")}`}
                          title={s.intelligenceState ?? ""}
                        >
                          {intelligenceSignalLabel(s.intelligenceSignal as "WATCH")}
                        </span>
                      )}
                      {s.intelligenceState && (
                        <span className={`ml-1 ${stateChipClass(s.intelligenceState)}`}>
                          {s.intelligenceState}
                        </span>
                      )}
                    </td>
                  )}
                  <td>
                    <span className={`text-[10px] capitalize ${ex.cls}`} title={s.executorReason ?? s.executed}>
                      {ex.text}
                    </span>
                  </td>
                  <td className="max-w-[100px] truncate">
                    {isTerminal ? (
                      <span className="text-accent">{s.symbol ?? shortAddr(s.mint, 4, 4)}</span>
                    ) : (
                      <Link
                        href={`/token/${s.mint}`}
                        className="text-accent hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {s.symbol ?? shortAddr(s.mint, 4, 4)}
                      </Link>
                    )}
                    {s.smartMoneyCount > 0 && (
                      <span className="ml-1 text-[8px] text-accent">{s.smartMoneyCount}SM</span>
                    )}
                    {s.rugLabel === "rugged" && (
                      <span className="ml-1 text-[9px] text-bad">rug</span>
                    )}
                  </td>
                  {!compact && (
                    <td className="max-w-[140px]">
                      <div className="flex flex-wrap gap-1">
                        <ModuleBar label="G" value={s.gradScore} />
                        <ModuleBar label="R" value={s.rugScore} invert />
                        <ModuleBar label="I" value={s.insiderScore} invert />
                      </div>
                    </td>
                  )}
                  <td className="text-right font-mono">{s.confluenceScore.toFixed(2)}</td>
                  <td
                    className={`text-right font-mono ${changeCls(s.changePct)}`}
                    title="Raw v_sol change since signal"
                  >
                    {s.changePct != null
                      ? `${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%`
                      : "—"}
                  </td>
                  <td
                    className={`text-right font-mono text-[10px] ${missedCls(s.missedProfitSol)}`}
                    title={
                      s.missedProfitSol != null
                        ? `Hypothetical paper PnL since buy @ ${s.recommendedAt ?? s.ts}`
                        : s.recommendedAt && s.executed.startsWith("executed")
                          ? "Entered — no missed PnL"
                          : "N/A"
                    }
                  >
                    {s.missedProfitSol != null ? (
                      <>
                        <span>
                          {s.missedProfitSol >= 0 ? "+" : ""}
                          {fmtSol(s.missedProfitSol, 3)}
                        </span>
                        {s.missedProfitPct != null && (
                          <span className="ml-1 text-[9px] opacity-80">
                            ({s.missedProfitPct >= 0 ? "+" : ""}
                            {s.missedProfitPct.toFixed(0)}%)
                          </span>
                        )}
                      </>
                    ) : s.recommendedAt ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className="text-muted">·</span>
                    )}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
