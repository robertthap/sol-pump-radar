"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const TokenPageClient = dynamic(
  () => import("@/components/TokenPageClient").then((m) => ({ default: m.TokenPageClient })),
  {
    ssr: false,
    loading: () => <div className="card h-96 animate-pulse bg-bg" />,
  },
);

export default function TokenDetailPage() {
  const params = useParams();
  const mint = typeof params.mint === "string" ? params.mint : "";
  return (
    <main className="app-page app-page-token">
      {mint ? <TokenPageClient mint={mint} /> : <p className="text-muted">Invalid token</p>}
    </main>
  );
}
