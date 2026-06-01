"use client";

import { useEffect, useState } from "react";
import { relTime } from "@/lib/ui/format";

export type TradeEntryChip = {
  id: string;
  side: "buy" | "sell";
  ts: string;
  sizeSol?: number | null;
  mcapUsd?: number | null;
  vSol?: number | null;
};

function fmtMcap(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export function TradeEntryStrip({ markers }: { markers: TradeEntryChip[] }) {
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  if (!markers.length) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {markers.map((m) => {
        const mcap = fmtMcap(m.mcapUsd);
        const isBuy = m.side === "buy";
        return (
          <div
            key={m.id}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] shadow-sm ${
              isBuy ? "border-ok/50 bg-ok/10 text-ok" : "border-bad/50 bg-bad/10 text-bad"
            }`}
          >
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                isBuy ? "border-ok bg-ok/20" : "border-bad bg-bad/20"
              }`}
              aria-hidden
            >
              <span className={`h-2 w-2 rounded-full ${isBuy ? "bg-ok" : "bg-bad"}`} />
            </span>
            <span className="font-semibold">{isBuy ? "Your buy" : "Your sell"}</span>
            {now > 0 && <span className="text-muted">{relTime(m.ts, now)}</span>}
            {mcap && <span>entry {mcap}</span>}
            {m.sizeSol != null && Number.isFinite(m.sizeSol) && (
              <span className="font-mono">{m.sizeSol.toFixed(3)} SOL</span>
            )}
            {m.vSol != null && Number.isFinite(m.vSol) && (
              <span className="text-muted">pool {m.vSol.toFixed(2)} SOL</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
