"use client";
import { breakevenHintText } from "@/lib/ui/plain-labels";

type Props = {
  takeProfitPct?: number;
  stopLossPct?: number;
  className?: string;
};

export function BreakevenHint({
  takeProfitPct = 0.4,
  stopLossPct = 0.15,
  className = "",
}: Props) {
  return (
    <p className={`text-[10px] text-muted ${className}`}>
      {breakevenHintText(takeProfitPct, stopLossPct)}
    </p>
  );
}
