import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  peekBatch, commitBatch, restoreBatch, advanceWatermark, batchWatermark,
  type Watermark,
} from "@/lib/workers/flush-queue";

/**
 * H07 — a failed DB flush must not lose events, and the watermark must only
 * advance after a successful commit.
 *
 * The old loop did the opposite of both: it spliced the batch out of the buffer
 * BEFORE inserting, and advanced the watermark when a notification was decoded.
 * A single insert failure therefore lost those events AND hid the hole from gap
 * recovery, which starts from the watermark.
 */
const NOW = new Date("2026-10-07T00:00:00Z");
const ev = (slot: number, signature = `sig-${slot}`) => ({ slot, signature });

describe("ingest flush queue (H07)", () => {
  describe("a failed flush keeps the events", () => {
    it("peeking does not remove anything, so a throw loses nothing", () => {
      const buffer = [ev(1), ev(2), ev(3)];
      const batch = peekBatch(buffer, 2);
      assert.equal(batch.length, 2);
      assert.equal(buffer.length, 3, "the buffer must still hold them until commit");
    });

    it("a restored batch goes back in front, in order", () => {
      const buffer = [ev(3), ev(4)];
      const batch = [ev(1), ev(2)];
      const r = restoreBatch(buffer, batch, 100);
      assert.deepEqual(buffer.map((e) => e.slot), [1, 2, 3, 4]);
      assert.equal(r.dropped, 0);
      assert.equal(r.restored, 2);
    });

    it("a full buffer drops the NEWEST and counts them, never silently", () => {
      const buffer = [ev(10), ev(11), ev(12)];
      const r = restoreBatch(buffer, [ev(1), ev(2)], 3);
      assert.equal(r.dropped, 2);
      assert.deepEqual(buffer.map((e) => e.slot), [1, 2, 10], "oldest kept, newest dropped");
    });

    it("committing removes exactly the committed count from the front", () => {
      const buffer = [ev(1), ev(2), ev(3)];
      assert.equal(commitBatch(buffer, 2), 2);
      assert.deepEqual(buffer.map((e) => e.slot), [3]);
    });

    it("items buffered DURING a flush survive the commit", () => {
      const buffer = [ev(1), ev(2)];
      const batch = peekBatch(buffer, 2);
      buffer.push(ev(3)); // arrived while the insert was in flight
      commitBatch(buffer, batch.length);
      assert.deepEqual(buffer.map((e) => e.slot), [3], "the late arrival must not be dropped");
    });

    it("committing more than the buffer holds cannot go negative", () => {
      const buffer = [ev(1)];
      assert.equal(commitBatch(buffer, 5), 1);
      assert.equal(buffer.length, 0);
    });
  });

  describe("the watermark follows commits, not arrivals", () => {
    it("a failed flush leaves the watermark where it was", () => {
      const current: Watermark = { slot: 100n, sig: "a", ts: NOW };
      // Nothing committed, so nothing to advance to.
      assert.equal(advanceWatermark(current, null), current);
    });

    it("advances to the highest slot the commit actually covered", () => {
      const current: Watermark = { slot: 100n, sig: "a", ts: NOW };
      const committed = batchWatermark([ev(101), ev(103), ev(102)], NOW)!;
      assert.equal(committed.slot, 103n);
      assert.equal(advanceWatermark(current, committed)!.slot, 103n);
    });

    it("never rewinds when a later batch commits a lower slot", () => {
      const current: Watermark = { slot: 500n, sig: "a", ts: NOW };
      const older = batchWatermark([ev(200)], NOW)!;
      assert.equal(advanceWatermark(current, older)!.slot, 500n);
    });

    it("the first commit sets it", () => {
      assert.equal(advanceWatermark(null, batchWatermark([ev(7)], NOW))!.slot, 7n);
    });

    it("a batch with no usable slot justifies no advance", () => {
      assert.equal(batchWatermark([{ slot: null }, { slot: 0 }], NOW), null);
      assert.equal(batchWatermark([], NOW), null);
      assert.equal(batchWatermark([{ slot: 0n }], NOW), null);
    });

    it("accepts bigint slots from the parser without a lossy conversion", () => {
      // Real Solana slots are far below 2^53, but the parser hands us bigint and
      // round-tripping through Number is exactly where a slot would lose digits.
      const huge = 9_007_199_254_740_993n; // 2^53 + 1
      assert.equal(batchWatermark([{ slot: huge, signature: "s" }], NOW)!.slot, huge);
      assert.equal(batchWatermark([{ slot: 5n }, { slot: 9n }], NOW)!.slot, 9n);
    });

    it("carries the signature of the highest slot, not of the last item", () => {
      const w = batchWatermark([ev(9, "nine"), ev(4, "four")], NOW)!;
      assert.equal(w.slot, 9n);
      assert.equal(w.sig, "nine");
    });
  });

  it("end to end: a failure then a retry loses nothing and moves the mark once", () => {
    const buffer = [ev(1), ev(2), ev(3)];
    let mark: Watermark | null = null;

    // Attempt 1 — the insert throws.
    const first = peekBatch(buffer, 3);
    restoreBatch(buffer, [], 100); // nothing spliced, so nothing to restore
    mark = advanceWatermark(mark, null);
    assert.equal(mark, null, "a failed flush must not move the watermark");
    assert.equal(buffer.length, 3, "a failed flush must not lose events");

    // Attempt 2 — the same batch commits.
    const second = peekBatch(buffer, 3);
    assert.deepEqual(second.map((e) => e.slot), first.map((e) => e.slot));
    commitBatch(buffer, second.length);
    mark = advanceWatermark(mark, batchWatermark(second, NOW));
    assert.equal(buffer.length, 0);
    assert.equal(mark!.slot, 3n);
  });
});
