import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyBlockTime, normalizeBlockTimeSec } from "@/lib/pump/parser";

// A plausible on-chain second-precision timestamp, used as the local-clock fallback.
const FB = 1_700_000_000;
const CHAIN_SEC = 1_699_999_000;

describe("classifyBlockTime", () => {
  it("accepts a plausible on-chain seconds value as chain time", () => {
    assert.deepEqual(classifyBlockTime(CHAIN_SEC, FB), { sec: CHAIN_SEC, source: "chain" });
  });

  it("converts a milliseconds value and still reports it as chain time", () => {
    assert.deepEqual(classifyBlockTime(CHAIN_SEC * 1000, FB), { sec: CHAIN_SEC, source: "chain" });
  });

  it("falls back to the local clock when chain time is missing", () => {
    assert.deepEqual(classifyBlockTime(0, FB), { sec: FB, source: "local" });
    assert.deepEqual(classifyBlockTime(Number.NaN, FB), { sec: FB, source: "local" });
    assert.deepEqual(classifyBlockTime(-1, FB), { sec: FB, source: "local" });
  });

  it("rejects a value below the 1e9 epoch floor", () => {
    assert.deepEqual(classifyBlockTime(999_999_999, FB), { sec: FB, source: "local" });
  });

  it("rejects a value more than 120s in the future", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    assert.equal(classifyBlockTime(nowSec + 3600, FB).source, "local");
    // ...but tolerates modest clock skew inside the 120s window.
    assert.equal(classifyBlockTime(nowSec + 60, FB).source, "chain");
  });

  it("normalizeBlockTimeSec returns exactly the classified second", () => {
    // The wrapper must stay behaviour-identical — it is on the ingest hot path.
    for (const raw of [CHAIN_SEC, CHAIN_SEC * 1000, 0, Number.NaN, -1, 999_999_999]) {
      assert.equal(normalizeBlockTimeSec(raw, FB), classifyBlockTime(raw, FB).sec);
    }
  });
});
