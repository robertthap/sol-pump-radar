import type { UiTradingMode } from "@/components/TradingModeProvider";

/** User-facing position label — never show engine "live" as real money in demo. */
export function PositionSourceBadge({
  uiMode,
  source,
}: {
  uiMode: UiTradingMode | null;
  source: "paper" | "live";
}) {
  if (uiMode === "real" && source === "live") {
    return (
      <span
        className="rounded bg-warn/20 px-1 py-0.5 text-[8px] font-semibold uppercase text-warn"
        title="On-chain trade using your wallet"
      >
        Real SOL
      </span>
    );
  }
  if (uiMode === "demo" && source === "live") {
    return (
      <span
        className="rounded bg-panel2 px-1 py-0.5 text-[8px] uppercase text-muted"
        title="Background learning bot — not your demo wallet or real funds"
      >
        Shadow
      </span>
    );
  }
  return null;
}
