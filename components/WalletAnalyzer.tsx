"use client";

import { useState } from "react";
import { Search, ShieldCheck, ShieldAlert, ShieldQuestion, CheckCircle2, XCircle } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import type { CopyTradeAnalysis } from "@/lib/wallet/copy-trade-safety";

type Profile = {
  wallet: string;
  closedMints: number;
  tradeCount: number;
  avgReturn: number | null;
  tStat: number | null;
  last5Return: number | null;
  sniperRate: number | null;
  bundleRate: number | null;
  clusterKind: string | null;
} | null;

type Resp = { wallet: string; profile: Profile; analysis: CopyTradeAnalysis };

const VERDICT: Record<
  CopyTradeAnalysis["verdict"],
  { label: string; cls: string; bar: string; Icon: typeof ShieldCheck }
> = {
  safe: { label: "SAFE TO COPY", cls: "text-ok border-ok/40 bg-ok/10", bar: "bg-ok", Icon: ShieldCheck },
  caution: { label: "CAUTION", cls: "text-warn border-warn/40 bg-warn/10", bar: "bg-warn", Icon: ShieldAlert },
  avoid: { label: "AVOID", cls: "text-bad border-bad/40 bg-bad/10", bar: "bg-bad", Icon: ShieldAlert },
  unknown: { label: "UNKNOWN", cls: "text-muted border-border bg-panel2", bar: "bg-muted", Icon: ShieldQuestion },
};

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
}

export function WalletAnalyzer() {
  const [addr, setAddr] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    const w = addr.trim();
    if (!w) return;
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const r = await fetch(`/api/wallet/analyze?wallet=${encodeURIComponent(w)}`, { cache: "no-store" });
      if (!r.ok) {
        setErr(r.status === 400 ? "That doesn't look like a Solana wallet address." : `Error ${r.status}`);
        return;
      }
      setData((await r.json()) as Resp);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  const v = data ? VERDICT[data.analysis.verdict] : null;

  return (
    <div className="card p-4">
      <h2 className="text-sm font-semibold">Analyze a wallet</h2>
      <p className="mb-3 text-[11px] text-muted">
        Paste any Solana wallet to check if it&apos;s safe to copy-trade — we score its closed-trade
        edge and flag bots, bundles and coordinated rings.
      </p>
      <div className="flex gap-2">
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
          placeholder="Paste wallet address…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-xs"
        />
        <button type="button" onClick={() => void run()} disabled={loading} className="btn-primary btn">
          <Search className="h-3.5 w-3.5" />
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {err && <p className="mt-3 text-xs text-bad">{err}</p>}

      {v && data && (
        <div className="mt-4 space-y-3">
          <div className={`flex items-center justify-between rounded-lg border px-3 py-2.5 ${v.cls}`}>
            <span className="flex items-center gap-2 text-sm font-bold tracking-wide">
              <v.Icon className="h-5 w-5" />
              {v.label}
            </span>
            <span className="text-right">
              <span className="font-mono text-lg font-bold">{data.analysis.score}</span>
              <span className="text-[10px] opacity-70">/100</span>
            </span>
          </div>

          <p className="text-sm text-fg">{data.analysis.headline}</p>

          <div className="flex items-center gap-2 text-xs">
            <CopyButton value={data.wallet} />
            {data.profile && (
              <span className="text-muted">
                · {data.profile.closedMints} closed · {data.profile.tradeCount} trades
              </span>
            )}
          </div>

          {data.profile && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              <Stat label="t-stat" value={data.profile.tStat?.toFixed(2) ?? "—"} />
              <Stat label="Avg ret" value={pct(data.profile.avgReturn)} tone={data.profile.avgReturn} />
              <Stat label="Last 5" value={pct(data.profile.last5Return)} tone={data.profile.last5Return} />
              <Stat label="Sniper" value={pct(data.profile.sniperRate)} />
              <Stat label="Bundle" value={pct(data.profile.bundleRate)} />
            </div>
          )}

          {data.analysis.positives.length > 0 && (
            <ul className="space-y-1">
              {data.analysis.positives.map((t, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-fg/90">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                  {t}
                </li>
              ))}
            </ul>
          )}
          {data.analysis.negatives.length > 0 && (
            <ul className="space-y-1">
              {data.analysis.negatives.map((t, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
                  {t}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-muted">
            Based only on trades our system has observed — not a guarantee. Copy-trading is high risk.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  const c = tone == null ? "" : tone > 0 ? "text-ok" : tone < 0 ? "text-bad" : "";
  return (
    <div className="rounded-md border border-border bg-bg px-2 py-1.5 text-center">
      <p className="text-[9px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`font-mono text-sm ${c}`}>{value}</p>
    </div>
  );
}
