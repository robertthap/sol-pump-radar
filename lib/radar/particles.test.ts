import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "@/lib/radar/layout";
import { pointOnCubic, ribbonCenterline, sampleKey, sampleNodeId, unitHash } from "@/lib/radar/particles";

describe("ribbonCenterline", () => {
  const l = computeLayout({
    counts: [
      { stage: "ingested", sub_stage: null, count: 100 },
      { stage: "scored", sub_stage: null, count: 40 },
      { stage: "rejected", sub_stage: "not_scored", count: 60 },
    ],
    width: 1000,
    height: 500,
  });

  it("starts mid-way down the stream where it leaves and ends mid-way down where it lands", () => {
    const edge = l.edges.find((e) => e.target === "rejected::not_scored");
    assert.ok(edge);
    const source = l.nodes.find((n) => n.id === "ingested");
    const target = l.nodes.find((n) => n.id === "rejected::not_scored");
    assert.ok(source && target);
    const curve = ribbonCenterline(edge.path);
    assert.ok(curve);
    const start = pointOnCubic(curve, 0);
    const end = pointOnCubic(curve, 1);
    assert.ok(Math.abs(start.x - (source.x + source.w)) < 0.02);
    assert.ok(Math.abs(end.x - target.x) < 0.02);
    assert.ok(Math.abs(end.y - (target.y + target.h / 2)) < 0.02, "lands at the rejection node's middle");
    assert.ok(start.y > source.y && start.y < source.y + source.h, "leaves from inside the source");
    const mid = pointOnCubic(curve, 0.5);
    assert.ok(mid.y > start.y && mid.y < end.y, "a falling stream falls monotonically");
  });

  it("returns null for anything that is not a layout ribbon", () => {
    assert.equal(ribbonCenterline(""), null);
    assert.equal(ribbonCenterline("M 0 0 L 10 10"), null);
  });
});

describe("unitHash and sample identity", () => {
  it("is deterministic, in [0, 1), and differs between coins", () => {
    const a = unitHash("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr");
    assert.equal(a, unitHash("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"));
    assert.ok(a >= 0 && a < 1);
    assert.notEqual(a, unitHash("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hs"));
    assert.equal(unitHash(""), unitHash(""));
  });

  it("names the node a sample belongs to and treats a later arrival as new", () => {
    const s = { stage: "rejected", sub_stage: "mcap_ceiling", mint: "M", created_at: "2026-09-13T12:00:00.000Z" };
    assert.equal(sampleNodeId(s), "rejected::mcap_ceiling");
    assert.equal(sampleNodeId({ ...s, sub_stage: null, stage: "scored" }), "scored");
    assert.notEqual(sampleKey(s), sampleKey({ ...s, created_at: "2026-09-13T12:00:05.000Z" }));
  });
});
