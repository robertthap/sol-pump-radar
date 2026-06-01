import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  commitPriority,
  shouldPersistDecisionLog,
} from "@/lib/intelligence/commit-policy-core";

describe("shouldPersistDecisionLog", () => {
  it("excludes WATCH and NONE", () => {
    assert.equal(shouldPersistDecisionLog("WATCH"), false);
    assert.equal(shouldPersistDecisionLog("NONE"), false);
  });

  it("includes buy and risk signals", () => {
    assert.equal(shouldPersistDecisionLog("BUY_STRONG"), true);
    assert.equal(shouldPersistDecisionLog("CONTINUATION_BUY"), true);
    assert.equal(shouldPersistDecisionLog("AVOID"), true);
  });
});

describe("commitPriority", () => {
  it("orders strong buys ahead of avoid", () => {
    assert.ok(commitPriority("BUY_STRONG") < commitPriority("AVOID"));
    assert.ok(commitPriority("CONTINUATION_BUY") < commitPriority("WATCH"));
  });
});
