"use client";

import { useMemo, useState } from "react";
import { stageColorToken, stageLabel, stageParent } from "@/lib/radar/layout";
import type { RadarSample, RadarSnapshot } from "@/lib/radar/snapshot";
import { LEAK_WHERE, RADAR_COLOR } from "@/components/radar/stage-copy";
import { shortMint } from "@/components/ticker/format";

/**
 * The calm after the flow: every reason a coin was stopped in this window, with a count and one real example.
 * This is the debugging surface — the flow shows the shape, this shows the truth.
 */
type Props = {
  data: RadarSnapshot | null;
  nowMs: number;
  onPickStage: (id: string) => void;
  onPickCoin: (s: RadarSample) => void;
};

type SortKey = "reason" | "where" | "count";
type Row = { id: string; label: string; where: string; count: number; share: number; example: RadarSample | null };

export function RejectionTable({ data, onPickStage, onPickCoin }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "count", desc: true });

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const stopped = data.counts.filter((c) => (c.stage === "rejected" || c.stage === "skipped") && c.count > 0);
    const total = stopped.reduce((a, b) => a + b.count, 0);
    return stopped.map((c) => {
      const id = `${c.stage}::${c.sub_stage ?? "unknown"}`;
      const parent = stageParent(id);
      const newest = data.samples
        .filter((s) => s.stage === c.stage && s.sub_stage === c.sub_stage)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      return {
        id,
        label: stageLabel(id),
        where: (parent && LEAK_WHERE[parent]) ?? "At the gates",
        count: c.count,
        share: total > 0 ? c.count / total : 0,
        example: newest ?? null,
      };
    });
  }, [data]);

  const sorted = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      if (sort.key === "count") return (a.count - b.count) * dir || a.label.localeCompare(b.label);
      const av = sort.key === "reason" ? a.label : a.where;
      const bv = sort.key === "reason" ? b.label : b.where;
      return av.localeCompare(bv) * dir || b.count - a.count;
    });
  }, [rows, sort]);

  const total = rows.reduce((a, b) => a + b.count, 0);
  const header = (key: SortKey, text: string, align = "left") => (
    <th scope="col" aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"} style={{ textAlign: align as "left" | "right" }}>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-inherit hover:text-fg"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === "count" }))}
      >
        {text}
        <span aria-hidden="true" className="text-[0.625rem]">
          {sort.key === key ? (sort.desc ? "▼" : "▲") : "↕"}
        </span>
      </button>
    </th>
  );

  return (
    <section className="card overflow-hidden" aria-labelledby="leaks-title">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="leaks-title" className="text-xs font-semibold uppercase tracking-wider text-muted">
          Where coins stopped
        </h2>
        <span className="font-mono text-xs tabular-nums text-muted">{total.toLocaleString("en-US")} stopped</span>
      </div>

      {sorted.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted">
          No coin was stopped in this window. With autotrade off, only ingestion and scoring run.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="table-feed">
            <thead>
              <tr>
                {header("reason", "Reason")}
                {header("where", "Where")}
                {header("count", "Coins", "right")}
                <th scope="col" style={{ textAlign: "right" }}>
                  Share
                </th>
                <th scope="col">Latest example</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="row-hover">
                  <td>
                    <button type="button" className="inline-flex items-center gap-2 text-left text-fg hover:text-accent" onClick={() => onPickStage(r.id)}>
                      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: RADAR_COLOR[stageColorToken(r.id)] }} aria-hidden="true" />
                      {r.label}
                    </button>
                  </td>
                  <td className="text-muted">{r.where}</td>
                  <td className="num font-mono tabular-nums" style={{ textAlign: "right" }}>
                    {r.count.toLocaleString("en-US")}
                  </td>
                  <td className="font-mono tabular-nums text-muted" style={{ textAlign: "right" }}>
                    {(r.share * 100).toFixed(1)}%
                  </td>
                  <td>
                    {r.example ? (
                      <button type="button" className="font-mono text-muted hover:text-accent" onClick={() => onPickCoin(r.example as RadarSample)}>
                        {shortMint(r.example.mint)}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
