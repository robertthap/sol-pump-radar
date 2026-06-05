"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Overall = {
  trades: number;
  winRate: number | null;
  totalPnlSol: number;
  expectancySol: number | null;
  avgHoldSeconds: number | null;
};
type Insights = {
  overall: Overall;
  strict: Overall;
  relaxed: Overall;
  reaction: { n: number; p50: number | null; p95: number | null };
};

function pct(v: number | null | undefined) {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function sol(v: number | null | undefined) {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(4)}`;
}
function dur(s: number | null | undefined) {
  if (s == null) return "—";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div className="min-w-[84px]">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`font-mono text-sm ${tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : ""}`}>
        {value}
      </p>
    </div>
  );
}

/** Profit/learning insight strip on the Trade page (Task 4.6). */
export function AutoTradeInsights() {
  const [data, setData] = useState<Insights | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/auto/session-insights?hours=168", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Insights;
        if (alive) {
          setData(j);
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (err && !data) return null;

  const o = data?.overall;
  const empty = !o || o.trades === 0;

  return (
    <section className="card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Auto-trade insights · last 7d</h3>
        <Link href="/analytics" className="text-[11px] text-accent hover:underline">
          Full analytics →
        </Link>
      </div>

      {empty ? (
        <p className="text-[11px] text-muted">
          No closed auto trades yet — start auto-trade and check the live log below for why entries
          are skipped.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Stat label="Trades" value={String(o!.trades)} />
            <Stat label="Win rate" value={pct(o!.winRate)} />
            <Stat
              label="Realized PnL"
              value={`${sol(o!.totalPnlSol)} SOL`}
              tone={o!.totalPnlSol >= 0 ? "ok" : "bad"}
            />
            <Stat
              label="Expectancy"
              value={`${sol(o!.expectancySol)} SOL`}
              tone={(o!.expectancySol ?? 0) >= 0 ? "ok" : "bad"}
            />
            <Stat label="Avg hold" value={dur(o!.avgHoldSeconds)} />
            <Stat
              label="Reaction (p50)"
              value={data?.reaction.p50 != null ? `${Math.round(data.reaction.p50)}s` : "—"}
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 border-t border-border/40 pt-2 text-[11px]">
            <span className="text-muted">Tiers:</span>
            <span>
              <b>Strict</b> {data!.strict.trades} trades · {pct(data!.strict.winRate)} ·{" "}
              <span className={(data!.strict.expectancySol ?? 0) >= 0 ? "text-ok" : "text-bad"}>
                {sol(data!.strict.expectancySol)} exp
              </span>
            </span>
            <span>
              <b>Relaxed</b> {data!.relaxed.trades} trades · {pct(data!.relaxed.winRate)} ·{" "}
              <span className={(data!.relaxed.expectancySol ?? 0) >= 0 ? "text-ok" : "text-bad"}>
                {sol(data!.relaxed.expectancySol)} exp
              </span>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
