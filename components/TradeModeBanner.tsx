"use client";
import Link from "next/link";
import { useTradingMode } from "@/components/TradingModeProvider";

type Props = {
  buyDisabled?: boolean;
};

/** Shown when user tries to trade without picking Demo/Real or without unlocking wallet. */
export function TradeModeBanner({ buyDisabled }: Props) {
  const { mode, needsSelection, loading, setMode } = useTradingMode();

  if (loading) return null;

  if (needsSelection || mode == null) {
    return (
      <div className="border-b border-accent/30 bg-accent/10 px-3 py-2 text-center text-xs">
        <span className="text-muted">Pick a mode to trade — </span>
        <button
          type="button"
          className="font-medium text-ok underline-offset-2 hover:underline"
          onClick={() => void setMode("demo")}
        >
          Demo (play money)
        </button>
        <span className="text-muted"> or </span>
        <Link href="/trade" className="font-medium text-accent underline-offset-2 hover:underline">
          Trade page
        </Link>
      </div>
    );
  }

  if (mode === "real" && buyDisabled) {
    return (
      <div className="border-b border-warn/30 bg-warn/10 px-3 py-2 text-center text-xs text-muted">
        Real mode — unlock your wallet in the header to buy. Or switch to{" "}
        <button
          type="button"
          className="font-medium text-ok underline-offset-2 hover:underline"
          onClick={() => void setMode("demo")}
        >
          Demo
        </button>{" "}
        to practice with play money.
      </div>
    );
  }

  return null;
}
