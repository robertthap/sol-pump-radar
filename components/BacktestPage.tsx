"use client";
import { useState } from "react";

type BacktestSummary = {
  params: Params;
  trades: TradeRow[];
  filtered: { reason: string; count: number }[];
  overall: {
    candidates: number;
    entered: number;
    closed: number;
    winRate: number;
    totalPnlSol: number;
    avgPnlSol: number;
    avgWinSol: number;
    avgLossSol: number;
    expectancySol: number;
    avgHoldSeconds: number;
    bestPnlSol: number;
    worstPnlSol: number;
    tp1HitCount: number;
    tp1HitRate: number;
    tp1TotalRealizedSol: number;
  };
  byAction: { action: string; n: number; winRate: number; totalPnlSol: number }[];
  byExitReason: { exitReason: string; n: number; totalPnlSol: number }[];
  durationMs: number;
};

type Params = {
  windowHours: number;
  sizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  actionFilter: ("BUY_STRONG" | "BUY_MODERATE")[];
  enableBotVetoes: boolean;
  enableRingVetoes: boolean;
  enableRugLabelVeto?: boolean;
  enableEntryFilter?: boolean;
  enableThreeGate?: boolean;
  strongOnly?: boolean;
  maxTrades: number;
  tp1Pct?: number;
  tp1Fraction?: number;
};

type TradeRow = {
  mint: string;
  decisionId: string;
  action: string;
  enteredAt: string;
  entryVSol: number;
  exitedAt: string | null;
  exitVSol: number | null;
  exitReason: string;
  pnlSol: number;
  pctOfSize: number;
  holdSeconds: number;
  tp1Hit?: boolean;
  tp1RealizedSol?: number;
};

const DEFAULTS: Params = {
  windowHours: 24,
  sizeSol: 0.05,
  takeProfitPct: 1.0,
  stopLossPct: 0.1,
  maxHoldMinutes: 120,
  actionFilter: ["BUY_STRONG", "BUY_MODERATE"],
  enableBotVetoes: true,
  enableRingVetoes: true,
  enableRugLabelVeto: true,
  enableEntryFilter: true,
  enableThreeGate: false,
  strongOnly: false,
  maxTrades: 500,
  tp1Pct: 0.5,
  tp1Fraction: 0.5,
};

function fmtSol(v: number, signed = true, d = 3): string {
  if (!Number.isFinite(v)) return "—";
  const s = v > 0 && signed ? "+" : "";
  return `${s}${v.toFixed(d)} SOL`;
}
function fmtPct(v: number, d = 0): string {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(d)}%`;
}

export function BacktestPage() {
  const [params, setParams] = useState<Params>(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [learning, setLearning] = useState(false);
  const [result, setResult] = useState<BacktestSummary | null>(null);
  const [learnResult, setLearnResult] = useState<{
    best: BacktestSummary & { label: string };
    alternatives: Array<{
      label: string;
      takeProfitPct: number;
      stopLossPct: number;
      maxHoldMinutes: number;
      winRate: number;
      totalPnlSol: number;
      expectancySol: number;
      entered: number;
    }>;
    insights: Array<{ kind: string; message: string; severity: string }>;
    durationMs: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function runLearn() {
    setLearning(true);
    setErr(null);
    try {
      const r = await fetch("/api/backtest/learn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          windowHours: params.windowHours,
          sizeSol: params.sizeSol,
          maxTrades: params.maxTrades,
          enableBotVetoes: params.enableBotVetoes,
          enableRingVetoes: params.enableRingVetoes,
          enableRugLabelVeto: params.enableRugLabelVeto !== false,
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      const j = await r.json();
      setLearnResult(j);
      setResult(j.best);
      setParams((p) => ({
        ...p,
        takeProfitPct: j.best.params.takeProfitPct,
        stopLossPct: j.best.params.stopLossPct,
        maxHoldMinutes: j.best.params.maxHoldMinutes,
        tp1Pct: j.best.params.tp1Pct,
        tp1Fraction: j.best.params.tp1Fraction,
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLearning(false);
    }
  }

  async function run() {
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      const j = (await r.json()) as BacktestSummary;
      setResult(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <section className="mb-3">
        <h1 className="text-xl font-semibold">Backtest</h1>
        <p className="text-sm text-muted">
          Replay decisions from the captured event history and score how the strategy would have
          performed with the chosen TP/SL/size and veto settings. Useful for tuning before turning
          on live mode.
        </p>
      </section>

      <section className="card mb-4 p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <Field label="Window (h)">
            <input
              type="number" min={1} max={168} step={1}
              value={params.windowHours}
              onChange={(e) => setParams({ ...params, windowHours: Number(e.target.value) || 24 })}
              className="input"
            />
          </Field>
          <Field label="Size (SOL)">
            <input
              type="number" min={0.001} max={10} step={0.005}
              value={params.sizeSol}
              onChange={(e) => setParams({ ...params, sizeSol: Number(e.target.value) || 0.05 })}
              className="input"
            />
          </Field>
          <Field label="TP %">
            <input
              type="number" min={5} max={500} step={5}
              value={Math.round(params.takeProfitPct * 100)}
              onChange={(e) => setParams({ ...params, takeProfitPct: (Number(e.target.value) || 50) / 100 })}
              className="input"
            />
          </Field>
          <Field label="SL %">
            <input
              type="number" min={5} max={100} step={5}
              value={Math.round(params.stopLossPct * 100)}
              onChange={(e) => setParams({ ...params, stopLossPct: (Number(e.target.value) || 30) / 100 })}
              className="input"
            />
          </Field>
          <Field label="Hold (min)">
            <input
              type="number" min={1} max={240} step={1}
              value={params.maxHoldMinutes}
              onChange={(e) => setParams({ ...params, maxHoldMinutes: Number(e.target.value) || 30 })}
              className="input"
            />
          </Field>
          <Field label="Max trades">
            <input
              type="number" min={10} max={2000} step={10}
              value={params.maxTrades}
              onChange={(e) => setParams({ ...params, maxTrades: Number(e.target.value) || 500 })}
              className="input"
            />
          </Field>
          <Field label="TP1 % (sell-half)">
            <input
              type="number" min={0} max={500} step={5}
              value={Math.round((params.tp1Pct ?? 0) * 100)}
              onChange={(e) => setParams({ ...params, tp1Pct: (Number(e.target.value) || 0) / 100 })}
              className="input"
            />
          </Field>
          <Field label="TP1 size %">
            <input
              type="number" min={0} max={95} step={5}
              value={Math.round((params.tp1Fraction ?? 0.5) * 100)}
              onChange={(e) => setParams({ ...params, tp1Fraction: (Number(e.target.value) || 50) / 100 })}
              className="input"
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={params.actionFilter.includes("BUY_STRONG")}
              onChange={(e) => {
                const next = new Set(params.actionFilter);
                if (e.target.checked) next.add("BUY_STRONG"); else next.delete("BUY_STRONG");
                setParams({ ...params, actionFilter: Array.from(next) as Params["actionFilter"] });
              }}
            />
            BUY_STRONG
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={params.actionFilter.includes("BUY_MODERATE")}
              onChange={(e) => {
                const next = new Set(params.actionFilter);
                if (e.target.checked) next.add("BUY_MODERATE"); else next.delete("BUY_MODERATE");
                setParams({ ...params, actionFilter: Array.from(next) as Params["actionFilter"] });
              }}
            />
            BUY_MODERATE
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={params.enableBotVetoes}
              onChange={(e) => setParams({ ...params, enableBotVetoes: e.target.checked })}
            />
            Bot vetoes (bundle/sniper/mech)
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={params.enableRingVetoes}
              onChange={(e) => setParams({ ...params, enableRingVetoes: e.target.checked })}
            />
            Ring vetoes
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={params.enableRugLabelVeto !== false}
              onChange={(e) => setParams({ ...params, enableRugLabelVeto: e.target.checked })}
            />
            Rug-label vetoes (Kalacheva)
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={params.enableEntryFilter !== false}
              onChange={(e) => setParams({ ...params, enableEntryFilter: e.target.checked })}
            />
            Light filter (confluence + modules)
          </label>
          <label className="flex items-center gap-1 text-xs" title="Uses historical scores; wallet gate is approximate">
            <input
              type="checkbox"
              checked={!!params.enableThreeGate}
              onChange={(e) =>
                setParams({
                  ...params,
                  enableThreeGate: e.target.checked,
                  enableEntryFilter: e.target.checked ? true : params.enableEntryFilter,
                })
              }
            />
            Full live filter (three-gate, approximate)
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={!!params.strongOnly}
              onChange={(e) => setParams({ ...params, strongOnly: e.target.checked })}
            />
            Strong buys only
          </label>
          <button
            type="button"
            onClick={run}
            disabled={running || learning}
            className="btn btn-primary disabled:opacity-50"
          >
            {running ? "Running…" : "Run backtest"}
          </button>
          <button
            type="button"
            onClick={runLearn}
            disabled={running || learning}
            className="btn btn-ghost border-accent text-accent disabled:opacity-50"
          >
            {learning ? "Learning…" : "Auto-learn TP/SL"}
          </button>
          {err && <span className="text-xs text-bad">{err}</span>}
        </div>
      </section>

      {learnResult && (
        <section className="card mb-4 p-4">
          <h2 className="mb-2 text-sm font-semibold">Learning recommendations</h2>
          <p className="mb-2 text-xs text-muted">
            Best combo: <b>{learnResult.best.label}</b> · ran in {learnResult.durationMs}ms
          </p>
          <ul className="mb-3 space-y-1 text-xs">
            {learnResult.insights.map((ins, i) => (
              <li
                key={i}
                className={
                  ins.severity === "good"
                    ? "text-ok"
                    : ins.severity === "warn"
                      ? "text-warn"
                      : "text-muted"
                }
              >
                {ins.message}
              </li>
            ))}
          </ul>
          {learnResult.alternatives.length > 0 && (
            <div className="text-[10px] text-muted">
              Runners-up:{" "}
              {learnResult.alternatives
                .slice(0, 3)
                .map((a) => `${a.label} (${fmtSol(a.expectancySol)}/trade)`)
                .join(" · ")}
            </div>
          )}
        </section>
      )}

      {result && (
        <>
          <section className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Candidates" value={String(result.overall.candidates)} />
            <Stat label="Entered" value={String(result.overall.entered)} />
            <Stat label="Closed" value={String(result.overall.closed)} />
            <Stat label="Win rate" value={fmtPct(result.overall.winRate)} tone={result.overall.winRate >= 0.5 ? "ok" : "warn"} />
            <Stat label="Total PnL" value={fmtSol(result.overall.totalPnlSol)} tone={result.overall.totalPnlSol >= 0 ? "ok" : "bad"} />
            <Stat label="Expectancy" value={fmtSol(result.overall.expectancySol)} tone={result.overall.expectancySol >= 0 ? "ok" : "bad"} />
            <Stat label="Avg hold" value={`${Math.round(result.overall.avgHoldSeconds / 60)} min`} />
            <Stat
              label="TP1 hits"
              value={`${result.overall.tp1HitCount} (${fmtPct(result.overall.tp1HitRate)})`}
              tone={result.overall.tp1HitCount > 0 ? "ok" : undefined}
            />
          </section>
          {result.overall.tp1HitCount > 0 && (
            <section className="mb-3">
              <p className="text-xs text-muted">
                TP1 ladder fired on <b>{result.overall.tp1HitCount}</b> trades, locking in{" "}
                <b className={result.overall.tp1TotalRealizedSol >= 0 ? "text-ok" : "text-bad"}>
                  {fmtSol(result.overall.tp1TotalRealizedSol)}
                </b>{" "}
                before final exit (Kalacheva 2026 §6.3 ladder).
              </p>
            </section>
          )}

          <section className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="card p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">By action</div>
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted">
                  <tr><th className="text-left">action</th><th>n</th><th>win</th><th className="text-right">total</th></tr>
                </thead>
                <tbody>
                  {result.byAction.map((b) => (
                    <tr key={b.action} className="border-t border-border/40">
                      <td className="py-1">{b.action}</td>
                      <td className="text-center">{b.n}</td>
                      <td className="text-center">{fmtPct(b.winRate)}</td>
                      <td className={`text-right ${b.totalPnlSol >= 0 ? "text-ok" : "text-bad"}`}>{fmtSol(b.totalPnlSol)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">By exit</div>
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted">
                  <tr><th className="text-left">exit</th><th>n</th><th className="text-right">total</th></tr>
                </thead>
                <tbody>
                  {result.byExitReason.map((b) => (
                    <tr key={b.exitReason} className="border-t border-border/40">
                      <td className="py-1">{b.exitReason}</td>
                      <td className="text-center">{b.n}</td>
                      <td className={`text-right ${b.totalPnlSol >= 0 ? "text-ok" : "text-bad"}`}>{fmtSol(b.totalPnlSol)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {result.filtered.length > 0 && (
            <section className="mb-4 card p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Filtered out</div>
              <div className="flex flex-wrap gap-1">
                {result.filtered.map((f) => (
                  <span key={f.reason} className="pill-side border-muted/40 text-muted">
                    {f.reason}: {f.count}
                  </span>
                ))}
              </div>
            </section>
          )}

          <section className="card p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                Trades ({result.trades.length})
              </div>
              <span className="text-[10px] text-muted">ran in {result.durationMs}ms</span>
            </div>
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="text-left">mint</th>
                    <th>action</th>
                    <th>exit</th>
                    <th className="text-right">pnl</th>
                    <th className="text-right">%</th>
                    <th className="text-right">hold</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(0, 200).map((t) => (
                    <tr key={t.decisionId} className="border-t border-border/40">
                      <td className="py-1 font-mono text-[10px]">{t.mint.slice(0, 6)}…{t.mint.slice(-4)}</td>
                      <td className="text-center">{t.action.replace("BUY_", "")}</td>
                      <td className="text-center">{t.exitReason}</td>
                      <td className={`text-right ${t.pnlSol >= 0 ? "text-ok" : "text-bad"}`}>{fmtSol(t.pnlSol)}</td>
                      <td className={`text-right ${t.pctOfSize >= 0 ? "text-ok" : "text-bad"}`}>{fmtPct(t.pctOfSize)}</td>
                      <td className="text-right text-muted">{Math.round(t.holdSeconds / 60)}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted">{label}</div>
      {children}
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const cls = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-fg";
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}
