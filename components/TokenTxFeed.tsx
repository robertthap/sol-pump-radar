"use client";
import { useCallback, useEffect, useState } from "react";
import { shortAddr, relTime } from "@/lib/ui/format";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Tx = {
  ts: string;
  kind: string;
  side: string;
  solAmount: number | null;
  vSol: number | null;
  wallet: string | null;
  signature: string;
};

export function TokenTxFeed({ mint, txs: externalTxs }: { mint: string; txs?: Tx[] }) {
  const [txs, setTxs] = useState<Tx[]>(externalTxs ?? []);

  useEffect(() => {
    if (externalTxs) setTxs(externalTxs);
  }, [externalTxs]);

  const load = useCallback(async () => {
    if (externalTxs) return;
    try {
      const r = await fetch(`/api/tokens/${mint}/transactions?limit=60`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { txs: Tx[] };
      setTxs(j.txs ?? []);
    } catch {
      /* ignore */
    }
  }, [mint, externalTxs]);

  useVisibleInterval(() => void load(), externalTxs ? 0 : 4_000, [load, externalTxs]);

  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="table-feed w-full text-xs">
        <thead className="sticky top-0 bg-panel">
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th className="text-right">SOL</th>
            <th className="text-right">Pool</th>
            <th>Wallet</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((t) => {
            const buy = t.side === "buy" || t.kind === "buy";
            return (
              <tr key={t.signature} className="border-t border-border/40">
                <td className="text-muted">{relTime(t.ts)}</td>
                <td className={buy ? "text-ok" : "text-bad"}>{buy ? "Buy" : "Sell"}</td>
                <td className={`text-right font-mono ${buy ? "text-ok" : "text-bad"}`}>
                  {t.solAmount != null ? t.solAmount.toFixed(3) : "—"}
                </td>
                <td className="text-right font-mono text-muted">
                  {t.vSol != null ? t.vSol.toFixed(2) : "—"}
                </td>
                <td className="font-mono text-muted" title={t.wallet ?? ""}>
                  {t.wallet ? shortAddr(t.wallet, 4, 4) : "—"}
                </td>
              </tr>
            );
          })}
          {txs.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-muted">
                No transactions yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
