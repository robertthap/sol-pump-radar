"use client";

import { useEffect, useId, useState } from "react";
import { useTicker } from "@/components/ticker/TickerProvider";
import { useTradingMode } from "@/components/TradingModeProvider";
import { submitAutoQuickStart, submitAutoStop, submitSellAll } from "@/lib/trade-client";
import { plainSol } from "@/components/ticker/format";
import { STRATEGIES, type ExecutionSetting } from "@/lib/strategies/catalog";
import { researchStrategy } from "@/lib/strategies/bot-config";

/**
 * Start / stop the EXISTING auto-trader and set its session-start limits.
 *
 * All four values (per-trade size, daily loss cap, max open positions, preset)
 * are parameters of the session the worker creates - the backend has no "edit a
 * running session". So while the bot runs they are shown READ-ONLY (with the
 * reason), and only when it is stopped do they become inputs. Start submits
 * them through the existing validated /api/auto/quick-start path; the worker
 * validates again and clamps max positions to PAPER_MAX_OPEN_POSITIONS. These
 * are requests, not authority. Nothing here bypasses the breaker, the daily
 * cap, the live gate, the vault, or the worker.
 */
type Preset = "balanced" | "conservative" | "aggressive" | "scalp" | "momentum" | "smartMoney" | "compounder" | "curveLadder" | "graduation" | "scaleIn";

const RANGES = {
  sizeSol: { min: 0.001, max: 5, hint: "0.001 - 5 SOL" },
  maxDailyLossSol: { min: 0.001, max: 1000, hint: "0.001 - 1000 SOL" },
  maxConcurrent: { min: 1, max: 50, hint: "1 - 50" },
} as const;

export function BotControls() {
  const { data, refresh } = useTicker();
  const { refresh: refreshMode } = useTradingMode();
  const bot = data?.bot;
  const running = bot?.running ?? false;
  const uiMode = data?.status.uiMode ?? null;

  const [preset, setPreset] = useState<Preset>("curveLadder");
  const [execution, setExecution] = useState<ExecutionSetting>("BASE");
  const research = researchStrategy(preset);
  const [size, setSize] = useState("");
  const [cap, setCap] = useState("");
  const [maxPos, setMaxPos] = useState("");
  const [errors, setErrors] = useState<{ size?: string; cap?: string; maxPos?: string }>({});
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const ids = { size: useId(), cap: useId(), maxPos: useId(), preset: useId() };

  // Prefill from the last session (or defaults) once data arrives and the bot is stopped.
  useEffect(() => {
    if (!bot || running) return;
    setSize((v) => (v === "" ? String(bot.sizeSol) : v));
    setCap((v) => (v === "" ? String(bot.maxDailyLossSol) : v));
    setMaxPos((v) => (v === "" ? String(bot.effectiveMaxConcurrent) : v));
  }, [bot, running]);

  function validate(): { sizeSol: number; maxDailyLossSol: number; maxConcurrent: number } | null {
    const next: typeof errors = {};
    const s = research ? STRATEGIES[research].size : Number(size);
    const c = Number(cap);
    const m = Number(maxPos);
    if (!Number.isFinite(s) || s < RANGES.sizeSol.min || s > RANGES.sizeSol.max) next.size = `Enter a size between ${RANGES.sizeSol.hint}.`;
    if (!Number.isFinite(c) || c < RANGES.maxDailyLossSol.min || c > RANGES.maxDailyLossSol.max) next.cap = `Enter a cap between ${RANGES.maxDailyLossSol.hint}.`;
    // The worker clamps to PAPER_MAX_OPEN_POSITIONS. Refuse anything above it HERE,
    // with the reason, rather than accepting a number that would silently run lower.
    const ceiling = Math.min(RANGES.maxConcurrent.max, bot?.maxConcurrentCeiling ?? RANGES.maxConcurrent.max);
    if (!Number.isInteger(m) || m < RANGES.maxConcurrent.min || m > ceiling)
      next.maxPos = `Enter a whole number between 1 and ${ceiling}. The ceiling is PAPER_MAX_OPEN_POSITIONS in .env.local (worker restart to change).`;
    setErrors(next);
    if (Object.keys(next).length) {
      const first = next.size ? ids.size : next.cap ? ids.cap : ids.maxPos;
      document.getElementById(first)?.focus();
      return null;
    }
    return { sizeSol: s, maxDailyLossSol: c, maxConcurrent: m };
  }

  async function start() {
    if (busy) return;
    const v = validate();
    if (!v) return;
    if (research && uiMode !== "demo") { setMsg({ tone: "bad", text: "Choose a Demo wallet to run these paper-only research strategies." }); return; }
    if (uiMode === "real") {
      const ok = window.confirm(
        `Start REAL auto-trading - the bot places on-chain trades with real SOL.\n\n` +
          `Size: ${v.sizeSol} SOL per trade · preset: ${preset} · daily cap: ${v.maxDailyLossSol} SOL · max ${v.maxConcurrent} open.\n` +
          `It keeps trading until you press Stop. Continue?`,
      );
      if (!ok) return;
    }
    setBusy("start");
    setMsg(null);
    try {
      const j = await submitAutoQuickStart({ preset, ...v, researchExecution: execution });
      if (!j.ok) setMsg({ tone: "bad", text: `Start failed: ${j.error ?? "unknown"}. Check the worker is running and try again.` });
      else setMsg({ tone: "ok", text: `Bot started - ${v.sizeSol} SOL per trade, up to ${v.maxConcurrent} open.` });
      await Promise.all([refresh(), refreshMode({ force: true })]);
    } catch (e) {
      setMsg({ tone: "bad", text: `Start failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    if (busy) return;
    setBusy("stop");
    setMsg(null);
    try {
      const sold = await submitSellAll({ scope: "all" });
      if (!sold.ok || sold.failedCount > 0) {
        setMsg({
          tone: "bad",
          text: `Could not close every position (${sold.closedCount} closed, ${sold.failedCount} failed). The bot is still running so positions remain managed.`,
        });
        await refresh();
        return;
      }
      const j = await submitAutoStop("ticker_stop");
      if (!j.ok) setMsg({ tone: "bad", text: `Stop failed: ${j.error ?? "unknown"}. Try again.` });
      else setMsg({ tone: "ok", text: `Bot stopped. ${sold.closedCount} open position${sold.closedCount === 1 ? "" : "s"} closed.` });
      await Promise.all([refresh(), refreshMode({ force: true })]);
    } catch (e) {
      setMsg({ tone: "bad", text: `Stop failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const halted = data?.status.breaker === "HALTED";
  const offline = data ? !data.status.workerAlive : false;

  return (
    <section className="card p-4" aria-labelledby="bot-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="bot-title" className="text-xs font-semibold uppercase tracking-wider text-muted">
          Auto trading
        </h2>
        <span className={`pill text-xs font-semibold ${running ? "badge-up" : "text-muted"}`}>
          <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${running ? "bg-ok motion-safe:animate-pulse" : "border border-muted"}`} />
          {running ? "RUNNING" : "STOPPED"}
        </span>
      </div>

      {(halted || offline) && (
        <p className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad" role="alert">
          {offline ? "Worker is offline - the bot cannot run until it is restarted." : "Trading is HALTED by the circuit breaker. Resume from the Halt control before starting."}
        </p>
      )}

      <fieldset className="mb-4 space-y-2" disabled={running || busy != null}>
        <legend className="mb-2 text-sm font-semibold">Select bot strategy</legend>
        {(["curveLadder", "graduation", "scaleIn"] as const).map((strategy) => {
          const selectedStrategy = running ? bot?.researchStrategy === strategy : preset === strategy;
          return <label key={strategy} className={`flex min-h-14 cursor-pointer items-start gap-2 rounded-lg border p-3 ${selectedStrategy ? "border-accent bg-accent/10" : "border-border bg-bg"} ${running ? "cursor-default" : ""}`}>
            <input className="mt-1 accent-emerald-500" type="radio" name="research-bot-strategy" value={strategy} checked={selectedStrategy} onChange={() => setPreset(strategy)} />
            <span><span className="block text-sm font-semibold">{STRATEGIES[strategy].name}</span><span className="mt-1 block text-xs text-muted">{strategy === "graduation" ? "After graduation · 0.552 SOL · tree exit" : strategy === "curveLadder" ? "Curve crossings · 0.349 SOL · 31s exit" : "Curve Ladder entry + one 0.349 SOL add"}</span></span>
          </label>;
        })}
        <p className="text-xs text-muted">Runs on the current market feed with your Demo balance. Trades, entry reasons and profit/loss appear here.</p>
      </fieldset>

      {running && bot ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <RO k="Strategy" v={bot.researchStrategy && researchStrategy(bot.researchStrategy) ? STRATEGIES[researchStrategy(bot.researchStrategy)!].name : bot.presetName ?? "Standard bot"} />
            <RO k="Per trade" v={plainSol(bot.sizeSol)} />
            <RO k="Daily loss cap" v={`${plainSol(bot.maxDailyLossSol, 2)} · used ${plainSol(bot.todayLossSol, 3)}`} />
            <RO
              k="Max open positions"
              v={`${bot.effectiveMaxConcurrent}${bot.maxConcurrent !== bot.effectiveMaxConcurrent ? ` (you asked ${bot.maxConcurrent}; PAPER_MAX_OPEN_POSITIONS=${bot.maxConcurrentCeiling} caps it)` : ""}`}
              cls={bot.maxConcurrent !== bot.effectiveMaxConcurrent ? "text-warn" : undefined}
            />
            <RO k="Exit rules" v={bot.researchStrategy ? (bot.researchStrategy === "graduation" ? "Frozen exit tree / 600s" : "31s / graduation") : `TP +${(bot.takeProfitPct * 100).toFixed(0)}% · SL -${(bot.stopLossPct * 100).toFixed(0)}% · ${bot.maxHoldMinutes} min hold`} />
            <RO
              k="Flat-position cut"
              v={
                bot.stagnationMinutes > 0
                  ? `${Math.round(bot.stagnationMinutes)} min if peak < +${(bot.stagnationMaxPeakPct * 100).toFixed(0)}%`
                  : "off"
              }
            />
            {data?.session?.mode === "live" && (
              <RO k="Live" v={`execution ${bot.liveExecution}${bot.liveDryRun === "on" ? " · DRY RUN" : ""}`} cls={bot.liveExecution === "on" && bot.liveDryRun !== "on" ? "text-bad" : "text-warn"} />
            )}
          </dl>
          {/* Slots: the one thing that explains "I have a good signal but nothing opens". */}
          {(() => {
            const used = data?.portfolio.openCount ?? 0;
            const cap = bot.effectiveMaxConcurrent;
            const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
            return (
              <div className="mt-3 rounded-md border border-border bg-bg/40 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted">Slots</span>
                  <span className={`font-semibold tabular-nums ${bot.slotsFull ? "text-warn" : "text-fg"}`}>
                    {used} / {cap} open
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-panel2" aria-hidden="true">
                  <div className={`h-full rounded-full ${bot.slotsFull ? "bg-warn" : "bg-accent"}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1.5 text-muted">
                  {bot.slotsFull
                    ? `All ${cap} slots are full - new signals are not evaluated until a position closes (take-profit, stop-loss, trailing stop, ${bot.maxHoldMinutes}-min max hold, or Sell).`
                    : `${bot.pendingBuySignals} fresh buy signal${bot.pendingBuySignals === 1 ? "" : "s"} in the queue right now.`}
                  {bot.slotsFull && bot.pendingBuySignals > 0
                    ? ` ${bot.pendingBuySignals} fresh signal${bot.pendingBuySignals === 1 ? "" : "s"} waiting; only signals from the last ~2 min are considered when a slot frees.`
                    : ""}
                </p>
              </div>
            );
          })()}
          <p className="mt-2 text-xs text-muted">Stop the bot to change limits - they apply when a session starts.</p>
          <button
            type="button"
            onClick={() => void stop()}
            disabled={busy != null}
            aria-busy={busy === "stop"}
            className="btn btn-danger mt-3 min-h-11 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "stop" ? "Stopping…" : "Stop bot"}
          </button>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
          noValidate
        >
          <details>
            <summary className="cursor-pointer text-xs text-muted">Other bot presets</summary>
            <label htmlFor={ids.preset} className="mb-1 block text-xs text-muted">
              Strategy
            </label>
            <select
              id={ids.preset}
              value={preset}
              onChange={(e) => setPreset(e.target.value as Preset)}
              className="min-h-11 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <option value="compounder">Compounder ($2 a trade, fast)</option>
              <option value="curveLadder">Curve Ladder · paper</option>
              <option value="graduation">Graduation Scout (V1) · paper</option>
              <option value="scaleIn">Winner Scale-In · paper</option>
              <option value="balanced">Balanced</option>
              <option value="conservative">Conservative</option>
              <option value="aggressive">Aggressive</option>
              <option value="scalp">Scalp (fast turnover)</option>
              <option value="momentum">Momentum (only accelerating coins)</option>
              <option value="smartMoney">Smart Money (only when watched wallets buy)</option>
            </select>
            <p className="mt-1 text-xs text-muted">
              {research
                ? `${STRATEGIES[research].description} ${research === "scaleIn" ? "Bot baseline: Curve Ladder entries, so compare it against a Curve Ladder session." : ""}`
                : preset === "compounder"
                ? "Targets a fixed $2 per trade on a 0.1 SOL stake (+13.3% net after all fees — break-even alone is +2%), stop at −6%, cuts anything flat at 3 min, 10 min max hold, 10 slots. Only buys in the vSol 20–70 curve band, where better wallets actually operate and where our own trades hit +13.3% about twice as often. Needs a 31% win rate to break even; measured so far is 12–16%. UNPROVEN — trading faster multiplies whatever the expectancy is, including a negative one."
                : preset === "scalp"
                ? "Small profits, fast slots: banks half at +5%, trails from +6%, cuts anything still flat at 5 min, max 12 min hold. Unproven — being measured."
                : preset === "momentum"
                  ? "Only enters coins whose trading is accelerating with buyers on top (≥8 buys/5m, buys ≥ sells, volume running ≥1.5× its hourly pace). Exits match Balanced, so selection is the only difference. Expect far fewer trades. Unproven — being measured."
                  : preset === "smartMoney"
                    ? "Only enters when a wallet from your watchlist — or two wallets our stats rate as having an edge — is buying. Exits match Balanced. Expect very few trades: we only see bonding-curve activity, so a watched wallet buying an already-graduated coin is invisible to us. Unproven — being measured."
                    : "Sets take-profit, stop-loss and hold time. Your limits above override its size and cap."}
            </p>
          </details>
          {research && <p className="text-xs text-muted">{STRATEGIES[research].description}</p>}
          {!research && <StrategySelect />}
          {research ? <p className="rounded-md bg-panel2 p-2 text-xs">Fixed stake: <strong>{STRATEGIES[research].size} SOL</strong>{research === "scaleIn" ? " + one 0.349 SOL add" : ""}. Frozen research rules; paper only.</p> : <Num id={ids.size} label="Per trade limit" unit="SOL" value={size} onChange={setSize} onBlur={() => validate()} step="0.001" hint={RANGES.sizeSol.hint} error={errors.size} />}
          <Num id={ids.cap} label="Daily loss cap" unit="SOL" value={cap} onChange={setCap} onBlur={() => validate()} step="0.01" hint={RANGES.maxDailyLossSol.hint} error={errors.cap} />
          <Num
            id={ids.maxPos}
            label="Max open positions"
            value={maxPos}
            onChange={setMaxPos}
            onBlur={() => validate()}
            step="1"
            hint={bot ? `1 - ${Math.min(RANGES.maxConcurrent.max, bot.maxConcurrentCeiling)} (ceiling set by PAPER_MAX_OPEN_POSITIONS)` : RANGES.maxConcurrent.hint}
            error={errors.maxPos}
          />

          {research && <label className="block text-xs text-muted">Execution costs<select className="mt-1 min-h-11 w-full rounded-md px-3 text-sm" value={execution} onChange={(e) => setExecution(e.target.value as ExecutionSetting)}><option>OPTIMISTIC</option><option>BASE</option><option>CONSERVATIVE</option></select></label>}
          <button
            type="submit"
            disabled={busy != null || halted || offline || !data}
            aria-busy={busy === "start"}
            className="btn btn-brand min-h-11 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "start" ? "Starting…" : "Start bot"}
          </button>
        </form>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.tone === "ok" ? "text-ok" : "text-bad"}`} role={msg.tone === "ok" ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
      {bot?.researchStrategy && <div className="mt-4 space-y-2 border-t border-border pt-3 text-xs">
        <h3 className="font-semibold">Strategy activity</h3>
        <p className="text-muted" role="status">{bot.researchStatus ?? "Waiting for the worker"}</p>
        {bot.research && <>
          <p>{bot.research.performance.closed} closed · {bot.research.performance.wins} wins · {bot.research.performance.censored} censored</p>
          <p className="text-muted">{bot.research.counts.map((c) => `${c.status}: ${c.count}`).join(" · ")}</p>
          <div className="max-h-48 space-y-2 overflow-y-auto">{bot.research.recent.map((r, i) => <div key={`${r.mint}-${i}`} className="rounded-md bg-panel2 p-2"><p className="font-medium">{r.mint.slice(0,7)}… · {r.status}</p><p className="mt-1 text-muted">{r.reason}</p></div>)}</div>
        </>}
      </div>}
    </section>
  );
}

/**
 * Strategy (what the bot hunts) is a RUNTIME setting, not a session-start
 * parameter: the worker re-reads it every ~8 s, so it can change while running.
 * Reuses the existing /api/settings/signal-mode route and persists in
 * user_settings, which wins over .env SIGNAL_MODE by design.
 */
const STRATEGY_HELP: Record<"launch" | "hybrid" | "profit", string> = {
  launch: "Brand-new launches only. Highest risk/reward, most rugs.",
  hybrid: "Fresh launches plus established movers. Balanced.",
  profit: "Established movers only. Conservative, lower variance.",
};

function StrategySelect() {
  const { data, refresh } = useTicker();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = data?.signalMode.effective ?? "profit";

  async function change(next: "launch" | "hybrid" | "profit") {
    if (busy || next === current) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/settings/signal-mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? `Could not change strategy (HTTP ${r.status}).`);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-xs text-muted">
        Signal source
      </label>
      <select
        id={id}
        value={current}
        disabled={busy || !data}
        aria-busy={busy}
        aria-describedby={`${id}-hint`}
        onChange={(e) => void change(e.target.value as "launch" | "hybrid" | "profit")}
        className="min-h-11 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="launch">Launch</option>
        <option value="hybrid">Hybrid</option>
        <option value="profit">Profit</option>
      </select>
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
        {STRATEGY_HELP[current]} Feeds standard presets. Research strategies consume their own event stream. Takes effect within ~8 s.
      </p>
      {err && (
        <p className="mt-1 text-xs text-bad" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function RO({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <dt className="text-muted">{k}</dt>
      <dd className={`font-medium tabular-nums ${cls ?? "text-fg"}`}>
        {v}
      </dd>
    </div>
  );
}

function Num({
  id,
  label,
  unit,
  value,
  onChange,
  onBlur,
  step,
  hint,
  error,
}: {
  id: string;
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  step: string;
  hint: string;
  error?: string;
}) {
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted">
        {label}
        {unit ? ` (${unit})` : ""}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={!!error}
        aria-describedby={error ? `${hintId} ${errId}` : hintId}
        className={`min-h-11 w-full rounded-md border bg-bg px-3 text-sm tabular-nums text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${error ? "border-bad" : "border-border"}`}
      />
      <p id={hintId} className="mt-1 text-xs text-muted">
        {hint}
      </p>
      {error && (
        <p id={errId} className="mt-1 text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
