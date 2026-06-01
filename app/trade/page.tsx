"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import { AutoTradeHero } from "@/components/AutoTradeHero";
import { TradePageProvider } from "@/components/trade/TradePageProvider";

const PumpCoinSearch = dynamic(
  () => import("@/components/PumpCoinSearch").then((m) => ({ default: m.PumpCoinSearch })),
  { loading: () => <div className="mb-3 h-9" aria-hidden />, ssr: false },
);

const AutoTradePositions = dynamic(
  () => import("@/components/AutoTradePositions").then((m) => ({ default: m.AutoTradePositions })),
  {
    loading: () => (
      <div className="card h-40 animate-pulse overflow-hidden bg-gray-50" aria-label="Loading holdings" />
    ),
    ssr: false,
  },
);

const AutoTradeLog = dynamic(
  () => import("@/components/AutoTradeLog").then((m) => ({ default: m.AutoTradeLog })),
  {
    loading: () => (
      <div className="card h-32 animate-pulse overflow-hidden bg-gray-50" aria-label="Loading log" />
    ),
    ssr: false,
  },
);

const TradeClient = dynamic(
  () => import("@/components/TradePage").then((m) => ({ default: m.TradeClient })),
  {
    loading: () => (
      <div className="card h-56 animate-pulse overflow-hidden bg-gray-50" aria-label="Loading table" />
    ),
    ssr: false,
  },
);

const DemoGuideOverlay = dynamic(
  () => import("@/components/DemoGuideOverlay").then((m) => ({ default: m.DemoGuideOverlay })),
  { ssr: false },
);

export default function TradePage() {
  return (
    <TradePageProvider>
      <main className="mx-auto max-w-[1200px] px-4 pb-12 pt-4">
        <Suspense fallback={null}>
          <DemoGuideOverlay />
        </Suspense>
        <h1 className="mb-3 text-lg font-semibold">Trade</h1>
        <PumpCoinSearch compact />
        <section className="mb-4 space-y-3">
          <AutoTradeHero />
          <AutoTradePositions />
          <AutoTradeLog />
        </section>
        <TradeClient />
      </main>
    </TradePageProvider>
  );
}
