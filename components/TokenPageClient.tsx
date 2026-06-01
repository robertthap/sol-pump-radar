"use client";
import { TokenDexView } from "@/components/TokenDexView";
import { PumpCoinSearch } from "@/components/PumpCoinSearch";
import { TokenIntelligencePanel } from "@/components/TokenIntelligencePanel";

export function TokenPageClient({ mint }: { mint: string }) {
  return (
    <>
      <div className="mb-3">
        <PumpCoinSearch compact />
      </div>
      <div className="mb-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <TokenDexView mint={mint} />
        <TokenIntelligencePanel mint={mint} />
      </div>
    </>
  );
}
