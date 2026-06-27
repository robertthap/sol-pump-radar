/**
 * Next.js MUST NOT start workers. apps/worker is the single automation runtime.
 *
 * Database connection is created lazily on first use by lib/db/client.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { notePerf } = await import("@/lib/runtime/perf-tracker");
  notePerf("instrumentation register (web only — workers run via pnpm worker)");

  // Warm the SOL/USD cache so the FIRST chart/mcap render uses the real price, not
  // the $150 sync fallback (which showed a wrong mcap on open until a live-price
  // poll warmed it). HTTP-only — no workers, no DB — so it respects the rule above.
  const { getSolUsd } = await import("@/lib/market/sol-usd");
  void getSolUsd().catch(() => undefined);
  setInterval(() => void getSolUsd().catch(() => undefined), 60_000);
}
