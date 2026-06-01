"use client";
import { useCallback, useEffect, useState } from "react";
import { relTime, fmtSol } from "@/lib/ui/format";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { tierClass } from "@/lib/signals/quality";

type Signal = {
  id: string;
  ts: string;
  action: string;
  confluenceScore: number;
  qualityScore: number;
  qualityTier: "hot" | "good" | "fair" | "weak" | "avoid";
  tradable: boolean;
  vAtSignal: number | null;
  vNow: number | null;
  changePct: number | null;
  reasonHuman: string;
  smartMoneyCount?: number;
};

function label(a: string) {
  if (a === "BUY_STRONG") return "Strong";
  if (a === "BUY_MODERATE") return "Buy";
  if (a === "WATCH") return "Watch";
  if (a === "AVOID") return "Avoid";
  return a;
}

export function TokenSignalList({
  mint,
  signals: externalSignals,
}: {
  mint: string;
  signals?: Signal[];
}) {
  const [rows, setRows] = useState<Signal[]>(externalSignals ?? []);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (externalSignals) setRows(externalSignals);
  }, [externalSignals]);

  const load = useCallback(async () => {
    if (externalSignals) return;
    try {
      const r = await fetch(`/api/signals?mint=${mint}&hours=48&limit=50&sortBy=score`, {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = (await r.json()) as { signals: Signal[] };
      setRows(j.signals ?? []);
    } catch {
      /* ignore */
    }
  }, [mint, externalSignals]);

  useVisibleInterval(() => void load(), externalSignals ? 0 : 8_000, [load, externalSignals]);
  useVisibleInterval(() => setNow(Date.now()), 2_000, []);

  if (rows.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-muted">No system signals for this token yet.</p>
    );
  }

  return (
    <div className="max-h-48 overflow-auto border-t border-border">
      <table className="table-feed w-full text-[11px]">
        <thead className="sticky top-0 bg-panel">
          <tr>
            <th>When</th>
            <th>Q</th>
            <th>Signal</th>
            <th className="text-right">@</th>
            <th className="text-right">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              className={`border-t border-border/30 ${s.tradable ? "bg-ok/[0.04]" : ""}`}
              title={s.reasonHuman}
            >
              <td className="text-muted">{now > 0 ? relTime(s.ts, now) : "…"}</td>
              <td>
                <span className={`pill font-mono text-[9px] ${tierClass(s.qualityTier)}`}>
                  {s.qualityScore}
                </span>
              </td>
              <td>
                {label(s.action)}
                {s.tradable && <span className="ml-1 text-ok">✓</span>}
                {(s.smartMoneyCount ?? 0) > 0 && (
                  <span className="ml-1 text-accent">{s.smartMoneyCount}SM</span>
                )}
              </td>
              <td className="text-right font-mono">{fmtSol(s.vAtSignal, 2)}</td>
              <td
                className={`text-right font-mono ${
                  s.changePct != null && s.changePct > 0
                    ? "text-ok"
                    : s.changePct != null && s.changePct < 0
                      ? "text-bad"
                      : "text-muted"
                }`}
              >
                {s.changePct != null ? `${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
