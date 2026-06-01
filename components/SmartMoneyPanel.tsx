"use client";
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Row = {
  wallet: string;
  tradeCount: number;
  distinctMints: number;
  closedMints: number;
  avgReturn: number | null;
  stdReturn: number | null;
  tStat: number | null;
  lastReturn: number | null;
  last5Return: number | null;
  last10Return: number | null;
  isBumpBot: boolean;
  sniperRate: number | null;
  bundleRate: number | null;
  lastSeen: string | null;
  clusterId: string | null;
  clusterKind: string | null;
  clusterMembers: number | null;
  clusterConfidence: number | null;
};

function shortWallet(w: string): string {
  return w.length <= 10 ? w : `${w.slice(0, 4)}…${w.slice(-4)}`;
}
function pct(v: number | null | undefined, d = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(d)}%`;
}
function cls(v: number | null | undefined): string {
  if (v == null) return "text-muted";
  if (v > 0) return "text-ok";
  if (v < 0) return "text-bad";
  return "text-muted";
}

export function SmartMoneyPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [cleanOnly, setCleanOnly] = useState(true);

  const tick = useCallback(async () => {
    try {
      const u = `/api/smart-money?limit=40&minTstat=1&minClosed=3${cleanOnly ? "&excludeRings=1" : ""}`;
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) {
        setErr(`HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as { rows: Row[] };
      setRows(j.rows);
      setLoading(false);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [cleanOnly]);

  useVisibleInterval(() => void tick(), 8_000, [tick]);

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Smart-Money Wallets</h2>
            <p className="text-[11px] text-muted">
              Wallets with statistically significant profitable returns (t-stat &gt; 1.645) and
              clean of bump-bot flags. Method:{" "}
              <a
                href="https://doi.org/10.1145/3774904.3792635"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-accent"
              >
                Luo et al. WWW &apos;26
              </a>
              .
            </p>
          </div>
          <label
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px]"
            title="Hide wallets that belong to a known bundle/sniper ring"
          >
            <input
              type="checkbox"
              checked={cleanOnly}
              onChange={(e) => setCleanOnly(e.target.checked)}
            />
            Clean only (exclude rings)
          </label>
        </div>
      </div>
      <div className="max-h-[480px] overflow-auto">
        <table className="table-feed">
          <thead>
            <tr>
              <th>Wallet</th>
              <th className="text-right">t-stat</th>
              <th className="text-right">Avg ret</th>
              <th className="text-right">Last 5</th>
              <th className="text-right">Trades</th>
              <th className="text-right">Coins</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted">
                  loading…
                </td>
              </tr>
            ) : err ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-bad">
                  {err}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted">
                  not enough closed trades yet — keep the system running
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const sniperHeavy = (r.sniperRate ?? 0) > 0.6;
                const bundleHeavy = (r.bundleRate ?? 0) > 0.4;
                const inBundleRing = r.clusterKind === "bundle_ring";
                const inSniperRing = r.clusterKind === "sniper_ring";
                const inCoBuyRing = r.clusterKind === "co_buy";
                const clean = !sniperHeavy && !bundleHeavy && !inBundleRing && !inSniperRing;
                return (
                  <tr key={r.wallet} className="row-hover">
                    <td className="font-mono text-accent">{shortWallet(r.wallet)}</td>
                    <td className="text-right font-mono">{r.tStat?.toFixed(2) ?? "—"}</td>
                    <td className={`text-right font-mono ${cls(r.avgReturn)}`}>{pct(r.avgReturn)}</td>
                    <td className={`text-right font-mono ${cls(r.last5Return)}`}>{pct(r.last5Return)}</td>
                    <td className="text-right font-mono text-muted">{r.tradeCount}</td>
                    <td className="text-right font-mono text-muted">{r.closedMints}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {inBundleRing && (
                          <span
                            className="pill text-bad"
                            title={`Member of bundle ring (${r.clusterMembers} wallets) — coordinated buyer`}
                          >
                            bundle ring · {r.clusterMembers}
                          </span>
                        )}
                        {inSniperRing && (
                          <span
                            className="pill text-warn"
                            title={`Member of sniper ring (${r.clusterMembers} wallets) — coordinated launch buyer`}
                          >
                            sniper ring · {r.clusterMembers}
                          </span>
                        )}
                        {inCoBuyRing && !inBundleRing && !inSniperRing && (
                          <span
                            className="pill text-muted"
                            title={`Member of co-buy ring (${r.clusterMembers} wallets) — buys with same wallets repeatedly`}
                          >
                            co-buy · {r.clusterMembers}
                          </span>
                        )}
                        {sniperHeavy && !inSniperRing && (
                          <span className="pill text-warn" title="frequently snipes new launches">
                            sniper {((r.sniperRate ?? 0) * 100).toFixed(0)}%
                          </span>
                        )}
                        {bundleHeavy && !inBundleRing && (
                          <span className="pill text-bad" title="frequently in launch-block bundles">
                            bundle {((r.bundleRate ?? 0) * 100).toFixed(0)}%
                          </span>
                        )}
                        {clean && <span className="pill text-ok">clean</span>}
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
