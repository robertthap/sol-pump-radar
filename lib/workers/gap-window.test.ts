import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coalesceWindow, censorDecision, startupWindow, type GapWindow } from "@/lib/workers/gap-window";

/**
 * H05 — on startup, use the persisted watermark; survive restarts and double
 * disconnects.
 */
const NOW = new Date("2026-10-07T12:00:00Z");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);
const MAX = 300;

describe("startup gap from the persisted watermark (H05)", () => {
  it("a restart produces a gap from where the last run stopped", () => {
    // The bug: getWatermark() was never called, hwmSlot started at 0n, and the
    // downtime produced no gap at all.
    const r = startupWindow({ lastSlot: 500n, lastTs: ago(60) }, NOW, MAX)!;
    assert.equal(r.window.fromSlot, 500n);
    assert.equal(r.downtimeSec, 60);
    assert.equal(r.recoverable, true);
  });

  it("a fresh database has nothing to recover", () => {
    assert.equal(startupWindow(null, NOW, MAX), null);
    assert.equal(startupWindow({ lastSlot: 0n, lastTs: ago(10) }, NOW, MAX), null);
  });

  it("long downtime is still REPORTED, just not walked", () => {
    const r = startupWindow({ lastSlot: 500n, lastTs: ago(86_400) }, NOW, MAX)!;
    assert.equal(r.recoverable, false, "a day of downtime must not hammer RPC");
    assert.equal(r.window.fromSlot, 500n, "but the window is still recorded, not forgotten");
    assert.equal(r.downtimeSec, 86_400);
  });

  it("the recoverable boundary is inclusive", () => {
    assert.equal(startupWindow({ lastSlot: 1n, lastTs: ago(MAX) }, NOW, MAX)!.recoverable, true);
    assert.equal(startupWindow({ lastSlot: 1n, lastTs: ago(MAX + 1) }, NOW, MAX)!.recoverable, false);
  });

  it("a clock that moved backwards cannot report negative downtime", () => {
    const r = startupWindow({ lastSlot: 1n, lastTs: new Date(NOW.getTime() + 5_000) }, NOW, MAX)!;
    assert.equal(r.downtimeSec, 0);
  });
});

describe("coalescing a disconnect during recovery (H05)", () => {
  const w = (slot: bigint, sec: number): GapWindow => ({ fromSlot: slot, fromTs: ago(sec) });

  it("a second disconnect is kept, not dropped", () => {
    // The old handler logged "coalescing into one gap" and returned, keeping
    // nothing. The second window simply vanished.
    assert.deepEqual(coalesceWindow(null, w(900n, 10)), w(900n, 10));
  });

  it("the EARLIEST start wins, because it covers strictly more", () => {
    const first = w(900n, 30);
    const earlier = w(700n, 60);
    assert.equal(coalesceWindow(first, earlier).fromSlot, 700n);
    assert.equal(coalesceWindow(earlier, first).fromSlot, 700n);
  });

  it("a later disconnect does not shrink an existing window", () => {
    assert.equal(coalesceWindow(w(700n, 60), w(900n, 10)).fromSlot, 700n);
  });

  it("repeated disconnects keep converging on the earliest", () => {
    let pending: GapWindow | null = null;
    for (const slot of [900n, 950n, 700n, 1000n, 800n]) {
      pending = coalesceWindow(pending, w(slot, 10));
    }
    assert.equal(pending!.fromSlot, 700n);
  });
});

describe("censoring labels over an ingest gap (H04/H05 data integrity)", () => {
  it("no overlapping gap means the label is usable", () => {
    const d = censorDecision(null);
    assert.equal(d.reason, null);
    assert.equal(d.trainable, true);
    assert.equal(d.retry, false);
  });

  it("a recoverable gap censors the label but keeps it open for retry", () => {
    const d = censorDecision({ unrecoverable: false });
    assert.equal(d.reason, "gap");
    assert.equal(d.trainable, false);
    assert.equal(d.retry, true, "recovery may still fill the hole");
  });

  it("an UNRECOVERABLE gap censors permanently and is never trainable", () => {
    // The bug: gapOverlaps excluded scope='unrecoverable', so these labels were
    // built as if the data were complete and fed into training.
    const d = censorDecision({ unrecoverable: true });
    assert.equal(d.reason, "gap_unrecoverable");
    assert.equal(d.trainable, false, "data known to be missing must never train a model");
    assert.equal(d.retry, false, "retrying forever would hide that it is permanently censored");
  });

  it("every censored case is marked, never silently usable", () => {
    for (const overlap of [{ unrecoverable: false }, { unrecoverable: true }]) {
      const d = censorDecision(overlap);
      assert.notEqual(d.reason, null, "a censored label must carry a reason it can be filtered by");
      assert.equal(d.trainable, false);
    }
  });
});
