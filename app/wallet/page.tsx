"use client";

import dynamic from "next/dynamic";

const WalletPage = dynamic(
  () => import("@/components/WalletPage").then((m) => ({ default: m.WalletPage })),
  { ssr: false, loading: () => <div className="card h-64 animate-pulse bg-bg" /> },
);

export default function Page() {
  return (
    // A div, not <main>: PortalLayout already renders the page's single <main> landmark.
    <div className="app-page">
      <WalletPage />
    </div>
  );
}
