"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const TokenPageClient = dynamic(
  () => import("@/components/TokenPageClient").then((m) => ({ default: m.TokenPageClient })),
  {
    ssr: false,
    loading: () => <div className="card h-96 animate-pulse bg-gray-50" />,
  },
);

export default function TokenDetailPage() {
  const params = useParams();
  const mint = typeof params.mint === "string" ? params.mint : "";
  return (
    <main className="mx-auto max-w-[1400px] px-4 pb-12 pt-4">
      {mint ? <TokenPageClient mint={mint} /> : <p className="text-muted">Invalid token</p>}
    </main>
  );
}
