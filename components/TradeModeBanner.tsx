"use client";
import Link from "next/link";
import { useTradingMode } from "@/components/TradingModeProvider";

type Props = {
  buyDisabled?: boolean;
};

/** Shown when user tries to trade without picking Demo/Real or without unlocking wallet. */
export function TradeModeBanner({ buyDisabled }: Props) {
  const { mode, needsSelection, loading } = useTradingMode();

  if (loading) return null;

  if (needsSelection || mode == null) {
    return (
      <div className="border-b border-accent/30 bg-accent/10 px-3 py-2 text-center text-xs">
        <span className="text-muted">Pick a wallet on the </span>
        <Link href="/" className="font-medium text-accent underline-offset-2 hover:underline">
          home page
        </Link>
        <span className="text-muted"> to start trading.</span>
      </div>
    );
  }

  if (mode === "real" && buyDisabled) {
    return (
      <div className="border-b border-warn/30 bg-warn/10 px-3 py-2 text-center text-xs text-muted">
        Real session — unlock your wallet in the header to buy. Use{" "}
        <span className="font-medium text-fg">Log off</span> in the header to return home and start a
        demo session instead.
      </div>
    );
  }

  return null;
}
