"use client";
import { useCallback, useEffect, useState } from "react";

type GateStats = {
  closedDemoTrades: number;
  demoDays: number;
  meetsDemoTime: boolean;
  meetsTradeCount: boolean;
  recommended: boolean;
};

type Props = {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function RealModeGate({ open, onCancel, onConfirm }: Props) {
  const [stats, setStats] = useState<GateStats | null>(null);
  const [ack, setAck] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/settings/real-gate", { cache: "no-store" });
      if (r.ok) setStats((await r.json()) as GateStats);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setAck(false);
      void load();
    }
  }, [open, load]);

  if (!open) return null;

  const canProceed = stats?.recommended || ack;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/60 p-4">
      <div className="card w-full max-w-md p-5 shadow-xl">
        <h2 className="mb-2 text-lg font-semibold">Switch to Real mode?</h2>
        <p className="mb-3 text-sm text-muted">
          Real mode uses your wallet and real SOL. You can lose everything. Demo mode is recommended
          until you have evidence the bot works for you.
        </p>

        {loading && <p className="mb-3 text-xs text-muted">Checking demo history…</p>}
        {stats && (
          <ul className="mb-3 space-y-1 text-xs text-muted">
            <li>
              Demo history: {stats.demoDays} day(s), {stats.closedDemoTrades} closed demo trade(s)
            </li>
            <li className={stats.meetsDemoTime ? "text-ok" : ""}>
              {stats.meetsDemoTime ? "✓" : "○"} 7+ days in demo
            </li>
            <li className={stats.meetsTradeCount ? "text-ok" : ""}>
              {stats.meetsTradeCount ? "✓" : "○"} 20+ closed demo trades
            </li>
          </ul>
        )}

        {!stats?.recommended && (
          <label className="mb-4 flex cursor-pointer items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5"
            />
            <span>I understand the risk and want to use real money anyway.</span>
          </label>
        )}

        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost flex-1" onClick={onCancel}>
            Stay on Demo
          </button>
          <button
            type="button"
            className="btn btn-danger flex-1 disabled:opacity-40"
            disabled={!canProceed}
            onClick={onConfirm}
          >
            Use Real mode
          </button>
        </div>
      </div>
    </div>
  );
}
