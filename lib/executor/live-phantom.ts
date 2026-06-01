import "server-only";

/**
 * Web-safe Phantom helpers.
 *
 * PHANTOM LIVE EXCEPTION (browser-signed):
 * - Phantom signs in the browser; the worker cannot own that signing session.
 * - Web builds unsigned txs here; after client broadcast, web queues PHANTOM_LIVE_RECORD_REQUESTED.
 * - phantom-live-listener is the ONLY audited path where a web command results in live ledger writes.
 * - Do NOT copy this pattern for generic execution or add other web-side live ledger writes.
 *
 * Web routes MUST import from this module, not from "@/lib/executor/live".
 */
export {
  buildUnsignedLiveBuyTx,
  buildUnsignedLiveSellTx,
  recordPhantomLiveBuy,
  recordPhantomLiveSell,
  type LiveTradeResult,
} from "./live";
