import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldFastLaneFire,
  FastLaneQueue,
  type FastLaneCandidate,
} from "@/lib/intelligence/fast-lane";
import { defaultGateConfig } from "@/lib/intelligence/gate-config";

const cfg = defaultGateConfig("hybrid"); // velocityFloor 0.38, rankFloor 0.55, allows launching
const MIN_VSOL = 10;

function cand(over: Partial<FastLaneCandidate> = {}): FastLaneCandidate {
  return {
    mint: "MintA",
    vSol: 30,
    priorVSol: 18, // +66% growth
    uniqueBuyers: 10,
    buySellRatio: 0.8,
    priceImpulsePct: 40,
    rank: 0.7,
    state: "launching",
    createdAtMs: 1_000,
    ...over,
  };
}

describe("shouldFastLaneFire", () => {
  it("fires on a strong fresh launch", () => {
    const d = shouldFastLaneFire(cand(), cfg, MIN_VSOL);
    assert.equal(d.fire, true);
    assert.ok(d.velocityScore >= cfg.engineA.velocityFloor);
  });

  it("blocks on risk flags", () => {
    const d = shouldFastLaneFire(cand({ riskFlags: { rug: true } }), cfg, MIN_VSOL);
    assert.equal(d.fire, false);
    assert.equal(d.reason, "risk_flag");
  });

  it("blocks below the SOL liquidity floor", () => {
    const d = shouldFastLaneFire(cand({ vSol: 5 }), cfg, MIN_VSOL);
    assert.equal(d.fire, false);
    assert.match(d.reason, /vSol/);
  });

  it("blocks on low velocity (flat launch)", () => {
    const d = shouldFastLaneFire(
      cand({ priorVSol: 30, uniqueBuyers: 1, buySellRatio: 0.5, priceImpulsePct: 1 }),
      cfg,
      MIN_VSOL,
    );
    assert.equal(d.fire, false);
    assert.match(d.reason, /velocity|veto/);
  });

  it("blocks on low rank", () => {
    const d = shouldFastLaneFire(cand({ rank: 0.3 }), cfg, MIN_VSOL);
    assert.equal(d.fire, false);
    assert.match(d.reason, /rank/);
  });

  it("blocks a disallowed state", () => {
    const d = shouldFastLaneFire(cand({ state: "cold" }), cfg, MIN_VSOL);
    assert.equal(d.fire, false);
    assert.match(d.reason, /state/);
  });
});

describe("FastLaneQueue", () => {
  it("enqueues a firing candidate and drains it", () => {
    const q = new FastLaneQueue();
    const c = cand();
    const r = q.offer(c, shouldFastLaneFire(c, cfg, MIN_VSOL), 2_000);
    assert.equal(r, "enqueued");
    const drained = q.drain();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.mint, "MintA");
    assert.equal(q.size(), 0);
  });

  it("dedupes the same mint within the window", () => {
    const q = new FastLaneQueue(64, 60_000);
    const c = cand();
    const d = shouldFastLaneFire(c, cfg, MIN_VSOL);
    assert.equal(q.offer(c, d, 2_000), "enqueued");
    assert.equal(q.offer(c, d, 2_500), "deduped"); // within 60s
    assert.equal(q.offer(c, d, 70_000), "enqueued"); // window passed
  });

  it("rejects a non-firing decision", () => {
    const q = new FastLaneQueue();
    const c = cand({ riskFlags: { rug: true } });
    assert.equal(q.offer(c, shouldFastLaneFire(c, cfg, MIN_VSOL), 2_000), "rejected");
  });

  it("drops oldest under backpressure", () => {
    const q = new FastLaneQueue(2, 0); // cap 2, no dedup
    for (let i = 0; i < 4; i++) {
      const c = cand({ mint: `M${i}` });
      q.offer(c, shouldFastLaneFire(c, cfg, MIN_VSOL), 2_000 + i);
    }
    assert.ok(q.size() <= 2);
  });

  it("measures decision→enqueue latency", () => {
    const q = new FastLaneQueue();
    const c = cand({ createdAtMs: 1_000 });
    q.offer(c, shouldFastLaneFire(c, cfg, MIN_VSOL), 1_080);
    const [item] = q.drain();
    assert.equal(FastLaneQueue.latencyMs(item!), 80);
  });
});
