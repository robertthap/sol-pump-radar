import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { feedDegraded, DROP_DEGRADED_MS, type FeedSnapshot } from "@/lib/workers/feed-health";

/**
 * H09 regression: a feed blip must not stop trading forever.
 *
 * The original check was `eventsDropped > 0` against a CUMULATIVE counter, so
 * one shed event permanently blocked entries until the worker restarted. The
 * bot took a few trades, dropped an event, and never traded again — with
 * nothing in the UI explaining why.
 */
const NOW = 1_000_000_000;
const ok: FeedSnapshot = { connState: "subscribed", eventsDropped: 0, lastDropAt: null };

describe("feedDegraded (H09)", () => {
  it("a healthy subscribed feed is not degraded", () => {
    assert.equal(feedDegraded(ok, NOW), false);
  });

  it("a drop happening NOW degrades the feed", () => {
    assert.equal(feedDegraded({ ...ok, eventsDropped: 1, lastDropAt: NOW - 1000 }, NOW), true);
  });

  it("an OLD drop does NOT degrade the feed — this is the bug", () => {
    // 58 events dropped an hour ago used to block every entry for the rest of
    // the process's life.
    const longAgo = { ...ok, eventsDropped: 58, lastDropAt: NOW - 3_600_000 };
    assert.equal(feedDegraded(longAgo, NOW), false, "a stopped blip is history, not a health problem");
  });

  it("a huge cumulative count with no recent drop is still healthy", () => {
    assert.equal(feedDegraded({ ...ok, eventsDropped: 1_000_000, lastDropAt: null }, NOW), false);
  });

  it("the recency boundary is exclusive at the threshold", () => {
    assert.equal(feedDegraded({ ...ok, lastDropAt: NOW - DROP_DEGRADED_MS + 1 }, NOW), true);
    assert.equal(feedDegraded({ ...ok, lastDropAt: NOW - DROP_DEGRADED_MS }, NOW), false);
  });

  it("a disconnected feed is degraded whatever the drop history", () => {
    for (const connState of ["idle", "connecting", "closed", "error"]) {
      assert.equal(feedDegraded({ ...ok, connState }, NOW), true, connState);
    }
    assert.equal(feedDegraded({ ...ok, connState: "open" }, NOW), false);
  });
});
