import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BoundedMap, BoundedSet } from "@/lib/shared/bounded-map";

describe("BoundedMap", () => {
  it("never exceeds maxSize", () => {
    const m = new BoundedMap<string, number>(3);
    for (let i = 0; i < 100; i++) m.set(`k${i}`, i);
    assert.equal(m.size, 3);
  });

  it("evicts the oldest insertion first", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1).set("b", 2).set("c", 3);
    assert.equal(m.has("a"), false, "oldest evicted");
    assert.equal(m.get("b"), 2);
    assert.equal(m.get("c"), 3);
  });

  it("re-setting a key refreshes it so hot keys survive", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1).set("b", 2);
    m.set("a", 10); // 'a' becomes newest, 'b' oldest
    m.set("c", 3);
    assert.equal(m.get("a"), 10, "refreshed key survived");
    assert.equal(m.has("b"), false, "stale key evicted instead");
  });

  it("does not grow when overwriting the same key", () => {
    const m = new BoundedMap<string, number>(5);
    for (let i = 0; i < 100; i++) m.set("same", i);
    assert.equal(m.size, 1);
    assert.equal(m.get("same"), 99);
  });

  it("supports delete and clear", () => {
    const m = new BoundedMap<string, number>(3);
    m.set("a", 1).set("b", 2);
    assert.equal(m.delete("a"), true);
    assert.equal(m.has("a"), false);
    m.clear();
    assert.equal(m.size, 0);
  });

  it("rejects a nonsensical ceiling", () => {
    assert.throws(() => new BoundedMap<string, number>(0), RangeError);
    assert.throws(() => new BoundedMap<string, number>(Number.NaN), RangeError);
  });
});

describe("BoundedSet", () => {
  it("never exceeds maxSize and evicts oldest", () => {
    const s = new BoundedSet<string>(2);
    s.add("a").add("b").add("c");
    assert.equal(s.size, 2);
    assert.equal(s.has("a"), false);
    assert.equal(s.has("c"), true);
  });

  it("re-adding an existing member does not grow or reorder", () => {
    const s = new BoundedSet<string>(2);
    s.add("a").add("b").add("a");
    assert.equal(s.size, 2);
    assert.equal(s.has("a"), true);
    assert.equal(s.has("b"), true);
  });
});
