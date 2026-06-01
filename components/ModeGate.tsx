"use client";
import { usePathname } from "next/navigation";
import { useTradingMode } from "@/components/TradingModeProvider";

export function ModeGate() {
  const pathname = usePathname();
  const { needsSelection, loading, setMode } = useTradingMode();

  const tradePaths = pathname.startsWith("/trade") || pathname.startsWith("/holdings");

  if (loading || !needsSelection || !tradePaths) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/40 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-sm p-6 shadow-xl">
        <h1 className="mb-2 text-lg font-semibold">Demo or real?</h1>
        <p className="mb-4 text-xs text-muted">Browse market freely — pick mode to trade.</p>
        <div className="grid gap-2">
          <button
            type="button"
            className="btn w-full border border-ok/40 bg-ok/10 py-3 text-ok"
            onClick={() => setMode("demo")}
          >
            Demo — play money
          </button>
          <button
            type="button"
            className="btn w-full border border-warn/40 bg-warn/10 py-3 text-warn"
            onClick={() => setMode("real")}
          >
            Real — wallet
          </button>
        </div>
      </div>
    </div>
  );
}
