/**
 * Next.js MUST NOT start workers. apps/worker is the single automation runtime.
 *
 * Database connection is created lazily on first use by lib/db/client.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { notePerf } = await import("@/lib/runtime/perf-tracker");
  notePerf("instrumentation register (web only — workers run via pnpm worker)");
}
