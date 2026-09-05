"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useTradingMode } from "@/components/TradingModeProvider";
import { SessionWalletBalance } from "@/components/SessionWalletBalance";

/**
 * /wallet - status, balance, mode, connection state, safe wallet controls.
 * Positions and P&L deliberately live on /trade only (one source of truth);
 * this page shows cash facts, not a second P&L calculation.
 */
export function WalletPage() {
  const { mode, walletUnlocked, liveExecution, liveDryRun, demo } = useTradingMode();

  const rows: Array<[string, string, string?]> =
    mode === "real"
      ? [
          ["Mode", "Real wallet", "text-warn"],
          ["Wallet", walletUnlocked ? "Unlocked" : "Locked", walletUnlocked ? "text-ok" : "text-muted"],
          ["Live execution", liveExecution === "on" ? "ON" : "OFF", liveExecution === "on" ? "text-bad" : "text-muted"],
          ["Dry run", liveDryRun === "on" ? "ON - orders are not sent" : "OFF", liveDryRun === "on" ? "text-ok" : "text-bad"],
        ]
      : mode === "demo"
        ? [
            ["Mode", "Demo - play money", "text-accent"],
            ["Open positions", demo ? String(demo.openPositions) : "—"],
            ["Closed trades", demo ? String(demo.closedTrades) : "—"],
            ["Starting balance", demo ? `${demo.startSol.toFixed(3)} SOL` : "—"],
          ]
        : [["Mode", "No wallet selected", "text-muted"]];

  return (
    <div className="space-y-3">
      <SessionWalletBalance variant="hero" showDemoReset showWalletControls />

      <section className="card p-4" aria-labelledby="wallet-status-title">
        <h2 id="wallet-status-title" className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
          Status
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          {rows.map(([k, v, cls]) => (
            <div key={k}>
              <dt className="text-xs text-muted">{k}</dt>
              <dd className={`font-medium tabular-nums ${cls ?? "text-fg"}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="text-sm text-muted">
        Positions, P&amp;L and the bot live on{" "}
        <Link href="/trade" className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
          Trade <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </p>
    </div>
  );
}
