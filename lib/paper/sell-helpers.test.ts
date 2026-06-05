import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateEntryMcapUsd,
  isAutoPaperEntry,
  manualPaperExitReason,
  resolveSellAllSessionFilter,
} from "@/lib/paper/sell-helpers";

describe("isAutoPaperEntry", () => {
  it("detects auto paper from boolean and string flags", () => {
    assert.equal(isAutoPaperEntry({ auto: true }), true);
    assert.equal(isAutoPaperEntry({ auto: "true" }), true);
    assert.equal(isAutoPaperEntry({ ui_mode: "demo" }), false);
    assert.equal(isAutoPaperEntry(null), false);
  });
});

describe("manualPaperExitReason", () => {
  it("labels auto vs demo and bulk vs single", () => {
    assert.equal(manualPaperExitReason(true, false), "manual_auto_sell");
    assert.equal(manualPaperExitReason(true, true), "manual_auto_sell_all");
    assert.equal(manualPaperExitReason(false, false), "manual_demo_sell");
    assert.equal(manualPaperExitReason(false, true), "manual_demo_sell_all");
  });
});

describe("estimateEntryMcapUsd", () => {
  it("scales mcap by bonding-curve price ratio squared", () => {
    const entry = estimateEntryMcapUsd(10, 20, 40_000);
    assert.equal(entry, 10_000);
  });

  it("returns null when inputs missing", () => {
    assert.equal(estimateEntryMcapUsd(null, 20, 40_000), null);
    assert.equal(estimateEntryMcapUsd(10, 0, 40_000), null);
  });

  it("returns null for implausible ratios (basis mismatch / graduated)", () => {
    // virtual entry (~31) vs real-reserve current (~1) → ratio 31, squared 961:
    // the old bug fabricated a ~$5M mcap from a $5k coin. Now guarded.
    assert.equal(estimateEntryMcapUsd(31, 1, 5_000), null);
    assert.equal(estimateEntryMcapUsd(1, 31, 5_000), null);
  });
});

describe("resolveSellAllSessionFilter", () => {
  it("filters by session only for auto scope", () => {
    assert.equal(resolveSellAllSessionFilter("auto", "42"), "42");
    assert.equal(resolveSellAllSessionFilter("all", "42"), null);
    assert.equal(resolveSellAllSessionFilter("auto", null), null);
  });
});
