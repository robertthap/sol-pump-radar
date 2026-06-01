"use client";

import dynamic from "next/dynamic";

const MarketView = dynamic(
  () => import("@/components/MarketView").then((m) => ({ default: m.MarketView })),
  {
    ssr: false,
    loading: () => (
      <main className="px-3 pb-8 pt-3">
        <div className="card h-64 animate-pulse bg-gray-50" />
      </main>
    ),
  },
);

export default function MarketPage() {
  return (
    <main className="px-3 pb-8 pt-3">
      <MarketView />
    </main>
  );
}
