import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapshotStaleFlags, DEX_STALE_MS } from "@/lib/workers/stale-flags";
import type { SolUsdFreshness } from "@/lib/market/sol-usd";

const FRESH: SolUsdFreshness = {
  usd: 150,
  ageMs: 1_000,
  everFetched: true,
  usingFallback: false,
  fresh: true,
};

describe("snapshotStaleFlags", () => {
  it("marks nothing stale when both sources are fresh", () => {
    assert.deepEqual(snapshotStaleFlags(FRESH, 1_000), {
      sol_price_stale: false,
      sol_price_fallback: false,
      dex_age_ms: 1_000,
      dex_stale: false,
    });
  });

  it("flags a never-fetched SOL price as both fallback and stale", () => {
    const fallback: SolUsdFreshness = {
      usd: 150,
      ageMs: Infinity,
      everFetched: false,
      usingFallback: true,
      fresh: false,
    };
    const f = snapshotStaleFlags(fallback, 1_000);
    assert.equal(f.sol_price_fallback, true);
    assert.equal(f.sol_price_stale, true);
  });

  it("flags an aged-but-fetched SOL price as stale, not fallback", () => {
    const aged: SolUsdFreshness = { ...FRESH, ageMs: 10 * 60_000, fresh: false };
    const f = snapshotStaleFlags(aged, 1_000);
    assert.equal(f.sol_price_stale, true);
    assert.equal(f.sol_price_fallback, false);
  });

  it("stores a never-fetched dex cache age as null rather than Infinity", () => {
    const f = snapshotStaleFlags(FRESH, Infinity);
    assert.equal(f.dex_age_ms, null);
    assert.equal(f.dex_stale, true);
  });

  it("treats the dex staleness threshold as exclusive", () => {
    assert.equal(snapshotStaleFlags(FRESH, DEX_STALE_MS).dex_stale, false);
    assert.equal(snapshotStaleFlags(FRESH, DEX_STALE_MS + 1).dex_stale, true);
  });

  it("emits an identical key set regardless of input — both arms must match", () => {
    const a = Object.keys(snapshotStaleFlags(FRESH, 1_000)).sort();
    const b = Object.keys(snapshotStaleFlags({ ...FRESH, fresh: false }, Infinity)).sort();
    assert.deepEqual(a, b);
    assert.deepEqual(a, ["dex_age_ms", "dex_stale", "sol_price_fallback", "sol_price_stale"]);
  });
});
