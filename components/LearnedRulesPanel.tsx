"use client";
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { postQueuedCommand } from "@/lib/trade-client";

type Rule = {
  id: string;
  createdAt: string;
  featureKey: string;
  operator: string;
  threshold: number;
  sampleN: number;
  lossRate: number;
  status: "applied" | "proposed" | "reverted";
  reason: string;
};

const FEATURE_LABEL: Record<string, string> = {
  "feat.unique_buyers_5m": "unique buyers / 5m",
  "feat.top3_buyer_share": "top-3 buyer concentration",
  "feat.dev_sell_vol_sol": "dev sell volume",
  "feat.age_at_entry": "token age at entry",
  "feat.sells_5m_over_trades_5m": "sell ratio / 5m",
  "module.M3_RUG": "M3 rug score",
  "module.M1_GRADUATION": "M1 grad score",
};

export function LearnedRulesPanel() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/learning/rules", { cache: "no-store" });
      if (!r.ok) {
        setErr(`HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as { rules: Rule[] };
      setRules(j.rules);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useVisibleInterval(() => void load(), 8_000, [load]);

  async function patch(id: string, status: Rule["status"]) {
    setBusyId(id);
    try {
      const res = await postQueuedCommand("/api/learning/rules", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (res.ok) await load();
      else setErr(res.error ?? "update failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Learned avoid rules
        </h2>
        <span className="text-[10px] text-muted">
          loss patterns auto-detected from closed trades
        </span>
      </div>
      <div className="max-h-[480px] overflow-auto">
        <table className="table-feed">
          <thead>
            <tr>
              <th>When</th>
              <th>Feature</th>
              <th>Rule</th>
              <th className="text-right">N</th>
              <th className="text-right">Loss</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!rules ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted">
                  {err ?? "loading…"}
                </td>
              </tr>
            ) : rules.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted">
                  no patterns mined yet — needs ~20+ closed trades within a feature bucket
                </td>
              </tr>
            ) : (
              rules.map((r) => {
                const label = FEATURE_LABEL[r.featureKey] ?? r.featureKey;
                const ruleStr = `${label} ${r.operator} ${r.threshold}`;
                const cls =
                  r.status === "applied"
                    ? "text-bad"
                    : r.status === "reverted"
                      ? "text-muted"
                      : "text-warn";
                return (
                  <tr key={r.id} className="row-hover" title={r.reason}>
                    <td className="font-mono text-[10px] text-muted">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="text-[11px]">{label}</td>
                    <td className="font-mono text-[11px]">
                      {r.operator} {r.threshold}
                    </td>
                    <td className="text-right font-mono">{r.sampleN}</td>
                    <td className="text-right font-mono">
                      {(r.lossRate * 100).toFixed(0)}%
                    </td>
                    <td>
                      <span className={`pill-side ${cls}`}>{r.status}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        {r.status !== "applied" && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-danger"
                            onClick={() => patch(r.id, "applied")}
                            disabled={busyId === r.id}
                            title={`Apply ${ruleStr} as a hard avoid`}
                          >
                            apply
                          </button>
                        )}
                        {r.status === "applied" && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => patch(r.id, "reverted")}
                            disabled={busyId === r.id}
                          >
                            revert
                          </button>
                        )}
                        {r.status === "reverted" && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => patch(r.id, "proposed")}
                            disabled={busyId === r.id}
                          >
                            re-propose
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
