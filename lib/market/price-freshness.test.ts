import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { priceFreshnessAt, SOL_USD_STALE_MS } from "@/lib/market/sol-usd";
import { solToAudDisplay } from "@/lib/ui/useSolUsd";

/**
 * M01 — a fallback or stale SOL/AUD price must never read as fresh.
 *
 * The display path reported a NEVER-FETCHED price as `ageMs: 0`, which is the
 * strongest possible claim of freshness. The dashboard then printed the static
 * A$230 fallback as though it were a live rate, with no warning, so every AUD
 * figure on screen was wrong by whatever the real rate had moved to.
 */
const NOW = 1_000_000_000;

describe("priceFreshnessAt (M01)", () => {
  it("a never-fetched price has no age and is not fresh", () => {
    const f = priceFreshnessAt(0, NOW);
    assert.equal(f.ageMs, null, "age 0 would claim it was just fetched");
    assert.equal(f.usingFallback, true);
    assert.equal(f.stale, true);
    assert.equal(f.everFetched, false);
  });

  it("a just-fetched price is fresh and not a fallback", () => {
    const f = priceFreshnessAt(NOW, NOW);
    assert.equal(f.ageMs, 0);
    assert.equal(f.usingFallback, false);
    assert.equal(f.stale, false);
  });

  it("an aged-but-real price is stale, never a fallback", () => {
    const f = priceFreshnessAt(NOW - SOL_USD_STALE_MS - 1, NOW);
    assert.equal(f.stale, true);
    assert.equal(f.usingFallback, false, "it was fetched once — that is stale, not fallback");
    assert.ok(f.ageMs != null && f.ageMs > SOL_USD_STALE_MS);
  });

  it("the staleness threshold is exclusive at the boundary", () => {
    assert.equal(priceFreshnessAt(NOW - SOL_USD_STALE_MS + 1, NOW).stale, false);
    assert.equal(priceFreshnessAt(NOW - SOL_USD_STALE_MS, NOW).stale, true);
  });

  it("a clock that moved backwards cannot produce a negative age or look fresh", () => {
    const f = priceFreshnessAt(NOW + 5_000, NOW);
    assert.ok(f.ageMs == null || f.ageMs >= 0, `negative age ${f.ageMs}`);
  });
});

describe("solToAudDisplay (M01)", () => {
  it("refuses to convert with a never-fetched rate", () => {
    assert.equal(solToAudDisplay(10, 230, { fallback: true, stale: true }), "A$ rate unavailable");
  });

  it("marks a stale but real rate instead of hiding it", () => {
    assert.equal(solToAudDisplay(10, 230, { stale: true }), "\u2248 A$2,300 (stale rate)");
  });

  it("a fresh rate renders plainly", () => {
    assert.equal(solToAudDisplay(10, 230, { stale: false, fallback: false }), "\u2248 A$2,300");
    assert.equal(solToAudDisplay(10, 230), "\u2248 A$2,300");
  });
});

describe("a failed fetch must not promote the fallback (M01 regression)", () => {
  it("seeding the fallback does not count as having fetched", async () => {
    // getSolUsd() used to do `if (cache.at === 0) cache = {...FALLBACK, at: now}`
    // on a failed fetch. That made everFetched true and usingFallback false, so
    // the hardcoded A$230 was reported as a live rate — defeating this finding
    // entirely. Caught by the daily report printing "A$0.00" instead of
    // "A$ rate unavailable" with no network available.
    const mod = await import("@/lib/market/sol-usd");
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("no network"))) as typeof fetch;
    try {
      await mod.getSolUsd();
      const snap = mod.solPriceCacheSnapshot();
      assert.equal(snap.usingFallback, true, "a failed fetch left the fallback looking real");
      assert.equal(snap.stale, true);
      assert.equal(snap.ageMs, null, "there is no age — nothing was ever fetched");
    } finally {
      globalThis.fetch = original;
    }
  });
});
