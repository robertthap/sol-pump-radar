"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { shortAddr } from "@/lib/ui/format";

type Performance = {
  creates24h: number;
  rugged24h: number;
  ruggedPctOfLabelled: number;
  ruggedPumped50Pct: number;
  ruggedPumped100Pct: number;
  ruggedPumped50PctRate: number;
  ruggedWithVolume10Trades: number;
  survivors24h: number;
  survivorRate: number;
  avgPeakVSolRugged: number | null;
  lessons: string[];
};

type Example = {
  mint: string;
  symbol: string | null;
  pumpMultiple: number | null;
  peakVSol: number | null;
  trades: number | null;
};

export function RugInsightsPanel() {
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [examples, setExamples] = useState<Example[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/learning/rug-traps", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { performance: Performance; examples: Example[] };
      setPerformance(j.performance);
      setExamples(j.examples ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useVisibleInterval(() => void load(), 30_000, [load]);

  if (!performance) {
    return <div className="card px-4 py-3 text-xs text-muted">Loading rug analysis…</div>;
  }

  const instantRug = performance.rugged24h - performance.ruggedPumped50Pct;

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">Rug vs winner analysis (24h)</h2>
        <p className="text-[11px] text-muted">
          Of labelled coins, ~{Math.round(performance.ruggedPctOfLabelled * 100)}% rug. The system
          studies which ones pumped first so it can avoid late-entry traps.
        </p>
      </div>
      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
        <Box label="Creates (24h)" value={performance.creates24h.toLocaleString()} />
        <Box
          label="Still trading"
          value={`${performance.survivors24h} (${Math.round(performance.survivorRate * 100)}%)`}
          tone="ok"
        />
        <Box label="Rugged" value={String(performance.rugged24h)} tone="bad" />
        <Box
          label="Rugged after ≥50% pump"
          value={`${performance.ruggedPumped50Pct} (${Math.round(performance.ruggedPumped50PctRate * 100)}%)`}
          tone="warn"
        />
        <Box label="Rugged with no big pump" value={String(Math.max(0, instantRug))} />
        <Box label="Doubled before rug" value={String(performance.ruggedPumped100Pct)} tone="warn" />
        <Box label="Rugs with ≥10 trades" value={String(performance.ruggedWithVolume10Trades)} />
        <Box
          label="Avg peak pool (rugged)"
          value={
            performance.avgPeakVSolRugged != null
              ? `${performance.avgPeakVSolRugged.toFixed(1)} SOL`
              : "—"
          }
        />
      </div>
      <ul className="border-t border-border px-4 py-2 text-[11px] text-muted list-disc pl-8">
        {performance.lessons.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {examples.length > 0 && (
        <div className="border-t border-border px-4 py-2">
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            Pump-then-rug examples (learning set)
          </h3>
          <div className="max-h-40 overflow-auto">
            <table className="table-feed w-full text-[11px]">
              <thead>
                <tr>
                  <th>Token</th>
                  <th className="text-right">Pump</th>
                  <th className="text-right">Peak</th>
                  <th className="text-right">Trades</th>
                </tr>
              </thead>
              <tbody>
                {examples.map((e) => (
                  <tr key={e.mint} className="border-t border-border/30">
                    <td>
                      <Link href={`/token/${e.mint}`} className="text-accent hover:underline">
                        {e.symbol ?? shortAddr(e.mint, 4, 4)}
                      </Link>
                    </td>
                    <td className="text-right font-mono text-warn">
                      {e.pumpMultiple != null ? `${e.pumpMultiple.toFixed(1)}×` : "—"}
                    </td>
                    <td className="text-right font-mono text-muted">
                      {e.peakVSol != null ? e.peakVSol.toFixed(1) : "—"}
                    </td>
                    <td className="text-right font-mono text-muted">{e.trades ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Box({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "bad" | "warn";
}) {
  const cls =
    tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <div className="rounded border border-border/50 bg-panel/30 px-2 py-1.5">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`font-mono text-sm ${cls}`}>{value}</div>
    </div>
  );
}
