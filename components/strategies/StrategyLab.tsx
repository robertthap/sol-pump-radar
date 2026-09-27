"use client";

import { useEffect, useRef, useState } from "react";
import { FlaskConical, Play, Download, ArrowRight, ChevronRight } from "lucide-react";
import { EXECUTION, STRATEGIES, type Episode, type ExecutionSetting, type StrategyId } from "@/lib/strategies/catalog";
import { exampleEvents } from "@/lib/strategies/examples";
import { runReplay, type ReplayResult } from "@/lib/strategies/replay";

type Result = ReplayResult & { source: "example" | "recorded"; data?: {
  latestTs: number | null; fromTs: number | null; events: number; selectedMints: number; ageSeconds: number | null; warnings: string[];
} };
const pct = (x: number | null) => x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const num = (x: number | null, places = 4) => x == null ? "—" : x.toFixed(places);
const selectClass = "min-h-11 w-full rounded-lg border border-border bg-bg px-3 text-sm";

export function StrategyLab() {
  const [strategy, setStrategy] = useState<StrategyId>("curveLadder");
  const [setting, setSetting] = useState<ExecutionSetting>("BASE");
  const [source, setSource] = useState<"example" | "recorded">("example");
  const [days, setDays] = useState(7), [mints, setMints] = useState(100);
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null), [selected, setSelected] = useState(0);
  const request = useRef<AbortController | null>(null);
  const config = STRATEGIES[strategy], execution = EXECUTION[setting];
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("strategy");
    if (id && Object.hasOwn(STRATEGIES, id)) setStrategy(id as StrategyId);
    return () => request.current?.abort();
  }, []);
  function reset() { setResult(null); setSelected(0); setError(null); }
  async function run() {
    if (busy) return;
    setBusy(true); reset();
    try {
      // Allow React to paint the running state before the pure local replay.
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (source === "example") {
        setResult({ ...runReplay(exampleEvents(), { strategy, setting, targetWallet: wallet.trim() || undefined, seed: 1701 }), source });
      } else {
        request.current = new AbortController();
        const q = new URLSearchParams({ strategy, setting, days: String(days), mints: String(mints) });
        if (wallet.trim()) q.set("targetWallet", wallet.trim());
        const response = await fetch(`/api/strategies/replay?${q}`, { signal: request.current.signal, cache: "no-store" });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Replay failed");
        setResult(json as Result);
      }
    } catch (e) { if (!(e instanceof Error && e.name === "AbortError")) setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function download() {
    if (!result) return;
    const blob = new Blob([JSON.stringify({ ...result, parameters: { days, mints, targetWallet: wallet || null, seed: 1701 } }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `${strategy}-${source}-${setting.toLowerCase()}.json`; a.click(); URL.revokeObjectURL(url);
  }
  const ep = result?.episodes[selected];
  return (
    <div className="app-page mx-auto max-w-[1500px] space-y-5 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent"><FlaskConical size={15} /> Research · paper simulation</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Strategy lab</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">Run each rule independently. See what triggered, follow the position, and compare against matched controls.</p>
        </div>
        <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs text-accent">No wallet or running bot required</span>
      </div>
      <p className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs text-warn">The supplied research reported negative results for all three rules. These are replication tests; the lab never places trades.</p>
      <div className="grid gap-3 lg:grid-cols-3" role="group" aria-label="Choose a strategy">
        {(Object.entries(STRATEGIES) as Array<[StrategyId, typeof config]>).map(([id, item], i) => (
          <button key={id} disabled={busy} onClick={() => { setStrategy(id); reset(); }} aria-pressed={strategy === id}
            className={`min-w-0 rounded-xl border p-4 text-left transition-colors disabled:opacity-60 ${strategy === id ? "border-accent bg-accent/5" : "border-border bg-panel hover:border-muted"}`}>
            <div className="mb-4 flex items-center justify-between text-xs text-muted"><span>0{i + 1} / {item.phase}</span><ChevronRight size={16} className={strategy === id ? "text-accent" : ""} /></div>
            <h2 className="font-semibold">{item.name}</h2>
            <p className="mt-2 text-xs text-muted">{item.size} SOL{ id === "scaleIn" ? " + one equal add" : " per entry"} · {item.hold}s maximum hold</p>
          </button>
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="card space-y-4 p-4">
          <h2 className="text-sm font-semibold">Configure test</h2>
          <label className="block space-y-1.5 text-xs text-muted">Data source
            <select className={selectClass} value={source} disabled={busy} onChange={(e) => { setSource(e.target.value as typeof source); reset(); }}>
              <option value="example">Synthetic example · learn the rules</option><option value="recorded">Recorded events · test my data</option>
            </select>
          </label>
          <p className="text-xs text-muted">{source === "example" ? "Generated price paths make entries and exits visible. These results are not market evidence." : "Replays full histories for a bounded sample of recently active mints. The window ends at the newest recorded event, even if the feed is stale."}</p>
          {source === "recorded" && <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs text-muted">Decision window<select className={selectClass} value={days} disabled={busy} onChange={(e) => { setDays(Number(e.target.value)); reset(); }}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select></label>
            <label className="space-y-1 text-xs text-muted">Mint sample<select className={selectClass} value={mints} disabled={busy} onChange={(e) => { setMints(Number(e.target.value)); reset(); }}><option value={25}>25 mints</option><option value={100}>100 mints</option><option value={200}>200 mints</option></select></label>
          </div>}
          <label className="block space-y-1.5 text-xs text-muted">Execution setting
            <select className={selectClass} value={setting} disabled={busy} onChange={(e) => { setSetting(e.target.value as ExecutionSetting); reset(); }}>
              {Object.keys(EXECUTION).map((key) => <option key={key}>{key}</option>)}
            </select>
          </label>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs"><dt className="text-muted">Delay</dt><dd>{execution.delay} slots</dd><dt className="text-muted">DEX fee per side</dt><dd>1.25%</dd><dt className="text-muted">Slippage / MEV</dt><dd>{execution.slippageBps} / {execution.mevBps} bps</dd><dt className="text-muted">Failure rate</dt><dd>{execution.failure * 100}%</dd><dt className="text-muted">Tx + priority</dt><dd>{num(0.000005 + execution.priority, 6)} SOL</dd></dl>
          <label className="block space-y-1.5 text-xs text-muted">Exclude wallet from flow (optional)
            <input className={selectClass} value={wallet} disabled={busy} onChange={(e) => { setWallet(e.target.value); reset(); }} placeholder="Target wallet address" spellCheck={false} />
          </label>
          <p className="text-xs text-muted">Its trades stay in the price path. Empty means the simulated trader has no trades in the recorded tape. MEV is an assumed cost.</p>
          <button onClick={() => void run()} disabled={busy} aria-busy={busy} className="btn-brand min-h-11 w-full gap-2 disabled:opacity-50"><Play size={15} />{busy ? "Running replay…" : source === "example" ? "Run visual example" : "Run recorded replay"}</button>
          {error && <p role="alert" className="text-xs text-bad">{error}</p>}
        </aside>
        <div className="min-w-0 space-y-4">
          <section className="card p-5">
            <h2 className="text-base font-semibold">{config.name}</h2><p className="mt-2 text-sm leading-relaxed text-muted">{config.description}</p>
            <div className="my-4 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-md bg-panel2 px-3 py-2">Observe opportunity</span><ArrowRight size={14} className="text-muted" /><span className="rounded-md bg-panel2 px-3 py-2">Check frozen conditions</span><ArrowRight size={14} className="text-muted" /><span className="rounded-md bg-accent/10 px-3 py-2 text-accent">Simulate fills + costs</span><ArrowRight size={14} className="text-muted" /><span className="rounded-md bg-panel2 px-3 py-2">Matched comparison</span></div>
            <p className="text-xs leading-relaxed text-muted">{config.caveat}</p>
            <p className="mt-3 text-xs text-muted">Source result, optimistic / base / conservative: <span className="text-fg">{config.reported}</span></p>
          </section>
          {result ? <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h2 className="text-sm font-semibold">{result.source === "example" ? "SYNTHETIC EXAMPLE — not measured performance" : "Recorded-data results"}</h2>
                <p className="mt-1 text-xs text-muted">{result.mints} mints · {result.setting} costs · seed 1701{result.data?.latestTs ? ` · latest event ${new Date(result.data.latestTs * 1000).toLocaleString()}` : ""}</p>
              </div>
              <button onClick={download} className="btn min-h-10"><Download size={14} /> Export result</button>
            </div>
            {result.data && <details className="rounded-lg border border-warn/30 p-3 text-xs" open>
              <summary className="cursor-pointer font-medium text-warn">Data coverage and limitations{result.data.ageSeconds != null && result.data.ageSeconds > 300 ? ` · feed is ${(result.data.ageSeconds / 86400).toFixed(1)} days old` : ""}</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-muted">{result.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </details>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {([ ["Opportunities", result.counts.opportunities], ["Rule fired", result.counts.fired], ["Closed", result.counts.closed], ["Censored", result.counts.censored], ["Data unavailable", result.counts.unavailable], ["No fill", result.counts.noFill] ] as const).map(([label, value]) => <div key={label} className="card p-3"><div className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</div><div className="mt-1 text-[11px] text-muted">{label}</div></div>)}
            </div>
            {!result.counts.opportunities && <p className="card p-5 text-sm text-muted">{strategy === "graduation" ? "No recorded graduation episodes in this sample. V1 needs migration events and AMM trades from the same pool. Run the visual example to inspect its behavior." : "No first curve crossings in this sample. Try more mints or a wider window. No return is reported for missing opportunities."}</p>}
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="card p-4"><h3 className="text-sm font-semibold">{strategy === "scaleIn" ? "Incremental return on the add" : "Net return per closed entry"}</h3>
                <p className="mt-2 text-3xl font-semibold tabular-nums">{pct(result.summary.selectedMean)}</p>
                <p className="mt-1 text-xs text-muted">After all simulated costs · {result.summary.selectedMints} selected mints</p>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs"><dt className="text-muted">Matched random mean</dt><dd>{pct(result.summary.controlMean)}</dd><dt className="text-muted">Matched excess</dt><dd>{pct(result.summary.excess)}</dd><dt className="text-muted">95% mint bootstrap</dt><dd>{result.summary.bootstrapInterval?.map(pct).join(" to ") ?? "Insufficient matched mints"}</dd><dt className="text-muted">Matched / unmatched</dt><dd>{result.summary.matched} / {result.summary.unmatched}</dd></dl>
                <p className="mt-3 text-[11px] text-muted">{result.summary.draws} random draws. Controls match class{strategy !== "graduation" ? " and crossing level" : ""}{strategy === "scaleIn" ? " and add second" : ""}; each selected mint is excluded from its own controls. Missing and censored outcomes are excluded, never set to zero.</p>
              </section>
              <section className="card p-4"><h3 className="text-sm font-semibold">Cumulative closed P&amp;L (SOL)</h3><p className="mt-1 text-xs text-muted">Independent episodes, equal starting stake; not portfolio equity.</p>
                <LineChart values={[0, ...result.equity.map((p) => p.pnl)]} label="Cumulative P&L across closed selected episodes" empty={result.equity.length === 0} />
              </section>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {strategy !== "graduation" && <section className="card p-4"><h3 className="mb-3 text-sm font-semibold">Triggers by crossing level</h3><div className="space-y-2">{result.byLevel.map((r) => <div key={r.level} className="grid grid-cols-[45px_1fr_60px] items-center gap-2 text-xs"><span className="text-muted">{r.level} SOL</span><div className="h-3 overflow-hidden rounded bg-panel2"><div className="h-3 rounded bg-accent" style={{ width: `${r.opportunities ? 100 * r.fired / r.opportunities : 0}%` }} /></div><span className="text-right tabular-nums">{r.fired} / {r.opportunities}</span></div>)}</div><p className="mt-3 text-[11px] text-muted">Triggered / observed first crossings. Re-crossing the same rung never creates another episode.</p></section>}
              <section className="card p-4"><h3 className="mb-3 text-sm font-semibold">Tail sensitivity</h3><table className="w-full text-left text-xs"><thead className="text-muted"><tr><th className="pb-2 font-normal">Top returns removed</th><th className="pb-2 text-right font-normal">Matched excess</th></tr></thead><tbody>{result.summary.tails.map((t) => <tr key={t.trim} className="border-t border-border"><td className="py-2">{t.trim * 100}%</td><td className="py-2 text-right tabular-nums">{pct(t.excess)}</td></tr>)}</tbody></table><p className="mt-2 text-[11px] text-muted">Recomputed after trimming within each matched group. A dash means no comparable outcomes remain.</p></section>
            </div>
            <section className="card min-w-0 p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Episode inspector</h3><span className="text-xs text-muted">Showing {result.displayedEpisodes} of {result.totalEpisodes}; signals first</span></div>
              <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-panel text-muted"><tr><th className="p-2 font-normal">Mint / episode</th><th className="p-2 font-normal">Rule</th><th className="p-2 font-normal">Outcome</th><th className="p-2 text-right font-normal">Net return</th></tr></thead><tbody>{result.episodes.map((e, i) => <tr key={e.id} className={`border-t border-border ${selected === i ? "bg-accent/5" : ""}`}><td className="p-2"><button className="min-h-9 text-left text-accent hover:underline" onClick={() => setSelected(i)} title={e.mint}>{e.mint.startsWith("EXAMPLE") ? e.mint : `${e.mint.slice(0, 7)}…${e.mint.slice(-4)}`}{e.level != null ? ` · ${e.level} SOL` : " · graduation"}</button></td><td className="p-2">{e.fired ? "Fired" : "No signal"}</td><td className="p-2">{e.status}</td><td className="p-2 text-right tabular-nums">{pct(e.netReturn)}</td></tr>)}</tbody></table></div>
              {ep && <EpisodeDetail episode={ep} />}
            </section>
            <p className="text-xs text-muted">Excluded rows: {Object.entries(result.excluded).map(([k, v]) => `${k}: ${v}`).join(" · ")}. Outcomes are reproducible for the same data, settings and seed.</p>
          </> : <section className="card flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center" aria-live="polite"><FlaskConical size={28} className="text-muted" /><h3 className="text-sm font-medium">{busy ? "Evaluating opportunities and matched controls…" : "Your test starts here"}</h3><p className="max-w-md text-xs leading-relaxed text-muted">{busy ? "Computing fills, individual decisions, 1,000 random selections, and mint-level uncertainty." : "Choose a rule and run the visual example to see how it behaves. Switch to recorded events to test it on your own ingested data."}</p></section>}
        </div>
      </div>
    </div>
  );
}

function EpisodeDetail({ episode: e }: { episode: Episode }) {
  const p0 = e.points[0]?.price;
  return <div className="mt-4 border-t border-border pt-4"><p className="break-all text-xs font-medium">{e.mint}</p><p className="mt-2 text-xs text-muted">{e.reason}</p>
    <div className="mt-3 grid gap-4 lg:grid-cols-2"><div>
      <h4 className="text-xs font-semibold">Price path relative to entry</h4>
      <LineChart values={e.points.map((p) => p0 ? p.price / p0 - 1 : 0)} times={e.points.map((p) => p.second)} addSecond={e.addSecond} label="Position price path, with entry, add, and exit annotations" empty={!e.points.length} percent />
      <p className="text-[11px] text-muted">Entry: {e.entryTs == null ? "—" : new Date(e.entryTs * 1000).toLocaleTimeString()} · Add: {e.addSecond == null ? "none" : `+${e.addSecond}s`} · Exit: {e.exitTs == null ? "unpriced / not filled" : `+${((e.exitTs - e.entryTs!) || 0).toFixed(1)}s`} · P&amp;L: {num(e.pnlSol)} SOL</p>
    </div><div className="space-y-2 text-xs">{Object.entries(e.checks).map(([key, value]) => <div key={key} className="flex justify-between gap-2"><span className="text-muted">{key}</span><span className={value == null ? "text-warn" : value ? "text-ok" : "text-bad"}>{value == null ? "Unavailable" : value ? "Pass" : "Fail"}</span></div>)}<div className="space-y-1 border-t border-border pt-2">{Object.entries(e.features).map(([key, value]) => <div key={key} className="flex justify-between gap-3"><span className="break-all text-muted">{key.replaceAll("_", " ")}</span><span className="tabular-nums">{num(value, 6)}</span></div>)}</div></div></div>
  </div>;
}

function LineChart({ values, label, empty, times, addSecond, percent = false }: { values: number[]; label: string; empty?: boolean; times?: number[]; addSecond?: number | null; percent?: boolean }) {
  if (empty || values.length < 2) return <div className="flex h-44 items-center justify-center text-xs text-muted">No priced path to plot</div>;
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values), span = hi - lo || 0.01;
  const x = (i: number) => 50 + 480 * (times ? times[i] / (times.at(-1) || 1) : i / (values.length - 1));
  const y = (v: number) => 145 - 115 * (v - lo) / span;
  const addX = addSecond != null && times ? 50 + 480 * addSecond / (times.at(-1) || 1) : null;
  return <svg viewBox="0 0 570 180" className="my-2 h-44 w-full" role="img" aria-label={label}>
    <title>{label}</title><line x1="50" x2="530" y1={y(0)} y2={y(0)} stroke="currentColor" className="text-muted/30" strokeDasharray="4 4" />
    <text x="4" y="32" fill="currentColor" className="text-muted" fontSize="10">{percent ? pct(hi) : hi.toFixed(3)}</text><text x="4" y="145" fill="currentColor" className="text-muted" fontSize="10">{percent ? pct(lo) : lo.toFixed(3)}</text>
    <polyline points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinejoin="round" />
    {addX != null && <><line x1={addX} x2={addX} y1="18" y2="150" stroke="currentColor" className="text-warn" strokeDasharray="3 3" /><text x={Math.min(485, addX + 4)} y="15" fontSize="10" fill="currentColor" className="text-warn">Add +{addSecond}s</text></>}
    <text x="50" y="169" fill="currentColor" className="text-muted" fontSize="10">{times ? "Entry" : "0"}</text><text x="530" y="169" textAnchor="end" fill="currentColor" className="text-muted" fontSize="10">{times ? `Exit / last mark +${times.at(-1)?.toFixed(1)}s` : `${values.length - 1} closed episodes`}</text>
  </svg>;
}
