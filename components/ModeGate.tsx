"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTradingMode } from "@/components/TradingModeProvider";

export function ModeGate() {
  const pathname = usePathname();
  const { needsSelection, loading } = useTradingMode();
  // Client-only modal driven by localStorage-hydrated state — render nothing until
  // mounted so SSR and the first client render match (no hydration mismatch / flash).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const tradePaths =
    pathname.startsWith("/trade") || pathname.startsWith("/wallet");

  if (!mounted || loading || !needsSelection || !tradePaths) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-bg/40 p-3 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="card max-h-[min(90dvh,480px)] w-full max-w-sm overflow-y-auto p-6 shadow-xl">
        <h1 className="mb-2 text-lg font-semibold">Pick a wallet first</h1>
        <p className="mb-4 text-xs text-muted">
          Demo and real accounts are separate sessions. Choose one on the home page — there is no
          switch while you are trading.
        </p>
        <Link href="/" className="btn w-full border border-accent/40 bg-accent/10 py-3 text-center text-accent">
          Go to wallet chooser
        </Link>
      </div>
    </div>
  );
}
