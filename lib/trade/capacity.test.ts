import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entryHeadroom } from "@/lib/trade/capacity";

describe("entryHeadroom — global + session cap (issue #11)", () => {
  it("uses the session cap when the global ledger has room", () => {
    assert.equal(
      entryHeadroom({ sessionMaxConcurrent: 3, ownedByActive: 1, globalCap: 8, totalOpen: 1, applyGlobalCap: true }),
      2,
    );
  });

  it("is bounded by the global cap when orphans hold slots (the bug)", () => {
    // Session owns 0, its cap is 8, BUT the global cap is 3 and 3 are already open
    // (orphaned by a stopped session) → no headroom, don't attempt opens.
    assert.equal(
      entryHeadroom({ sessionMaxConcurrent: 8, ownedByActive: 0, globalCap: 3, totalOpen: 3, applyGlobalCap: true }),
      0,
    );
  });

  it("takes the tighter of the two bounds", () => {
    // session headroom = 5-2 = 3; global headroom = 3-1 = 2 → 2 wins.
    assert.equal(
      entryHeadroom({ sessionMaxConcurrent: 5, ownedByActive: 2, globalCap: 3, totalOpen: 1, applyGlobalCap: true }),
      2,
    );
    // session headroom = 2-1 = 1; global headroom = 10-3 = 7 → 1 wins.
    assert.equal(
      entryHeadroom({ sessionMaxConcurrent: 2, ownedByActive: 1, globalCap: 10, totalOpen: 3, applyGlobalCap: true }),
      1,
    );
  });

  it("never returns negative", () => {
    assert.equal(
      entryHeadroom({ sessionMaxConcurrent: 3, ownedByActive: 5, globalCap: 3, totalOpen: 9, applyGlobalCap: true }),
      0,
    );
  });

  it("ignores the global cap for live sessions", () => {
    assert.equal(
      entryHeadroom({ sessionMaxConcurrent: 4, ownedByActive: 1, globalCap: 3, totalOpen: 99, applyGlobalCap: false }),
      3,
    );
  });
});
