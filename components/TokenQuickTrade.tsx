"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useTradingMode } from "@/components/TradingModeProvider";
import { TradeSizePicker } from "@/components/TradeSizePicker";
import { submitDemoTrade, submitLiveTrade } from "@/lib/trade-client";

/**
 * Token-page quick trade + breadcrumb. Closes the navigation loop (the token page
 * used to be a dead end): one click back to the desk, and a mode-aware Buy for this
 * specific coin. Real mode confirms before spending on-chain (mirrors TradePage).
 */
export function TokenQuickTrade({ mint, symbol }: { mint: string; symbol?: string | null }) {
  const { mode, refresh } = useTradingMode();
  const [size, setSize] = useState(0.05);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const label = symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const inSession = mode === "demo" || mode === "real";

  async function buy() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "demo") {
        const j = await submitDemoTrade({ mint, sizeSol: size, side: "buy" });
        setMsg(j.ok ? "Bought" : (j.error ?? "Buy failed"));
        if (j.ok) void refresh();
      } else if (mode === "real") {
        if (
          !window.confirm(
            `REAL on-chain BUY — this spends real SOL.\n\n` +
              `Buy ${size} SOL of ${label}?\n` +
              `A ~1% pump fee + slippage apply.`,
          )
        ) {
          setBusy(false);
          return;
        }
        const j = await submitLiveTrade("/api/trade/quick-buy", { mint, sizeSol: size });
        setMsg(j.ok ? "Sent" : (j.error ?? "Buy failed"));
        if (j.ok) void refresh();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/trade"
          prefetch={false}
          className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Trade
        </Link>
        {inSession && (
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
              mode === "demo" ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn"
            }`}
          >
            {mode === "demo" ? "Demo" : "Real"}
          </span>
        )}
      </div>

      {inSession ? (
        <div className="flex flex-wrap items-center gap-2">
          <TradeSizePicker size={size} onSizeChange={setSize} />
          <button
            type="button"
            className="btn btn-buy px-6 py-2 font-semibold"
            disabled={busy}
            onClick={() => void buy()}
          >
            {busy ? "…" : `Buy ${label}`}
          </button>
          {msg && <span className="text-xs text-muted">{msg}</span>}
        </div>
      ) : (
        <p className="text-xs text-muted">
          <Link href="/" className="text-accent hover:underline">
            Pick a wallet
          </Link>{" "}
          to trade this coin.
        </p>
      )}
    </section>
  );
}
