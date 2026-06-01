"use client";

import dynamic from "next/dynamic";

const HoldingsPage = dynamic(
  () => import("@/components/HoldingsPage").then((m) => ({ default: m.HoldingsPage })),
  { ssr: false, loading: () => <div className="card h-64 animate-pulse bg-gray-50" /> },
);

export default function Page() {
  return (
    <main className="mx-auto max-w-[1200px] px-4 pb-12 pt-4">
      <h1 className="mb-3 text-lg font-semibold">Holdings</h1>
      <HoldingsPage />
    </main>
  );
}
