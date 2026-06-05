"use client";

import dynamic from "next/dynamic";

const MarketView = dynamic(
  () => import("@/components/MarketView").then((m) => ({ default: m.MarketView })),
  {
    ssr: false,
    loading: () => (
      <main className="app-page !max-w-[1600px]">
        <div className="card h-64 animate-pulse bg-bg" />
      </main>
    ),
  },
);

export default function MarketPage() {
  return (
    <main className="app-page !max-w-[1600px]">
      <MarketView />
    </main>
  );
}
