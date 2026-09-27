import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRANCH_OPACITY,
  MIN_NODE_HEIGHT,
  NODE_GAP,
  SPINE_OPACITY,
  computeLayout,
  type Count,
  type Layout,
  type LayoutNode,
} from "@/lib/radar/layout";

const W = 1000;
const H = 500;
const PAD = 16; // default padding on every side
const STEP = (W - 2 * PAD) / 5;
const EPS = 1e-6;

const c = (stage: string, sub_stage: string | null, count: number): Count => ({ stage, sub_stage, count });
const layout = (counts: Count[]) => computeLayout({ counts, width: W, height: H });

function node(l: Layout, id: string): LayoutNode {
  const n = l.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} exists`);
  return n;
}

function edge(l: Layout, id: string) {
  const e = l.edges.find((x) => x.id === id);
  assert.ok(e, `edge ${id} exists`);
  return e;
}

/** Ribbon ends from "M x1 sTop C .., .., x2 tTop L x2 tBot C .., .., x1 sBot Z". */
function ends(path: string) {
  const n = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  assert.equal(n.length, 16, `ribbon path has 16 numbers: ${path}`);
  return { x1: n[0], sTop: n[1], c1x: n[2], c2x: n[4], x2: n[6], tTop: n[7], tBot: n[9], sBot: n[15] };
}

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

function assertWellFormed(l: Layout) {
  const ids = new Set(l.nodes.map((n) => n.id));
  assert.equal(ids.size, l.nodes.length, "node ids are unique");
  for (const n of l.nodes) {
    assert.ok(n.value > 0, `${n.id} has a positive value`);
    assert.ok(n.w > 0 && n.h >= MIN_NODE_HEIGHT - EPS, `${n.id} is visible`);
    assert.ok(n.x >= 0 && n.x + n.w <= W + EPS, `${n.id} inside the width`);
    assert.ok(n.y >= PAD - EPS && n.y + n.h <= H - PAD + EPS, `${n.id} inside the padded height`);
  }
  for (const e of l.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `${e.id} joins two drawn nodes`);
    assert.equal(e.id, `${e.source}->${e.target}`);
    assert.ok(e.value > 0);
    assert.ok(!/NaN|Infinity|e[+-]/.test(e.path), `${e.id} path is plain numbers`);
    assert.equal(e.colorToken, node(l, e.target).colorToken, `${e.id} takes the target's colour`);
  }
  // No two nodes overlap, except entry lanes, which are partitions of the entry rect.
  const solid = l.nodes.filter((n) => !n.id.startsWith("entry::"));
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i];
      const b = solid[j];
      const apart = a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS || a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS;
      assert.ok(apart, `${a.id} and ${b.id} do not overlap`);
    }
  }
}

describe("computeLayout: empty input", () => {
  it("no counts draws nothing", () => {
    assert.deepEqual(layout([]), { nodes: [], edges: [] });
  });

  it("only zero, NaN and negative counts draw nothing", () => {
    assert.deepEqual(layout([c("ingested", null, 0), c("scored", null, Number.NaN), c("gate_passed", null, -4)]), {
      nodes: [],
      edges: [],
    });
  });

  it("no drawable area draws nothing instead of throwing", () => {
    const counts = [c("ingested", null, 10)];
    assert.deepEqual(computeLayout({ counts, width: 0, height: H }), { nodes: [], edges: [] });
    assert.deepEqual(computeLayout({ counts, width: W, height: Number.NaN }), { nodes: [], edges: [] });
    assert.deepEqual(computeLayout({ counts, width: 20, height: 20, padding: { top: 10, right: 10, bottom: 10, left: 10 } }), {
      nodes: [],
      edges: [],
    });
  });
});

describe("computeLayout: single coin", () => {
  it("a lone coin is one node on the first column that fills the column height", () => {
    const l = layout([c("ingested", null, 1)]);
    assert.equal(l.nodes.length, 1);
    assert.equal(l.edges.length, 0);
    const n = node(l, "ingested");
    assert.ok(near(n.x + n.w / 2, PAD, EPS));
    assert.equal(n.y, PAD);
    assert.ok(near(n.h, H - 2 * PAD, EPS));
    assert.equal(n.label, "Ingested");
    assert.equal(n.colorToken, "ingest");
  });

  it("one coin that went all the way is a uniform ribbon through every stage", () => {
    const l = layout([
      c("ingested", null, 1),
      c("scored", null, 1),
      c("gate_passed", null, 1),
      c("decision_committed", null, 1),
      c("entry", "paper", 1),
      c("exit", "take_profit", 1),
      c("outcome", null, 1),
    ]);
    assertWellFormed(l);
    const heights = new Set(l.nodes.map((n) => n.h.toFixed(6)));
    assert.equal(heights.size, 1, "every node carries the same single coin");
    assert.deepEqual(
      l.edges.map((e) => e.id),
      [
        "ingested->scored",
        "scored->gate_passed",
        "gate_passed->decision_committed",
        "decision_committed->entry::paper",
        "entry->exit::take_profit",
        "exit::take_profit->outcome",
      ],
    );
  });

  it("one unscored coin among a million is still MIN_NODE_HEIGHT tall", () => {
    const l = layout([c("ingested", null, 1_000_000), c("scored", null, 999_999), c("rejected", "not_scored", 1)]);
    assertWellFormed(l);
    assert.equal(node(l, "rejected::not_scored").h, MIN_NODE_HEIGHT);
    const ribbon = ends(edge(l, "ingested->rejected::not_scored").path);
    assert.ok(near(ribbon.tBot - ribbon.tTop, MIN_NODE_HEIGHT), "its stream is as thick as its node");
  });
});

describe("computeLayout: realistic snapshot", () => {
  const counts = [
    c("ingested", null, 1200),
    c("rejected", "not_scored", 860),
    c("scored", null, 340),
    c("rejected", "avoid", 210),
    c("rejected", "no_price", 62),
    c("rejected", "bundle_veto", 30),
    c("rejected", "activity_floor", 15),
    c("rejected", "mcap_ceiling", 10),
    c("rejected", "stale", 5),
    c("gate_passed", null, 8),
    c("skipped", "insufficient_balance", 2),
    c("decision_committed", null, 6),
    c("skipped", "fill_rejected", 1),
    c("entry", "paper", 5),
    c("exit", "take_profit", 1),
    c("exit", "flat_cut", 2),
    c("exit", "stop_loss", 1),
    c("outcome", null, 4),
  ];
  const l = layout(counts);

  it("is well formed: in bounds, no overlaps, every edge joins drawn nodes", () => {
    assertWellFormed(l);
  });

  it("spine nodes sit on their column lines, top-aligned", () => {
    ["ingested", "scored", "gate_passed", "decision_committed", "entry", "outcome"].forEach((id, i) => {
      const n = node(l, id);
      assert.ok(near(n.x + n.w / 2, PAD + i * STEP, EPS), `${id} centred on column ${i}`);
      assert.equal(n.y, PAD, `${id} top-aligned`);
    });
  });

  it("the fullest column fills the inner height", () => {
    const bottoms = l.nodes.map((n) => n.y + n.h);
    assert.ok(near(Math.max(...bottoms), H - PAD, 1e-6));
  });

  it("leaks stack below the next spine node, biggest first, separated by the gap", () => {
    const scored = node(l, "scored");
    const notScored = node(l, "rejected::not_scored");
    assert.equal(notScored.x, scored.x, "same column as scored");
    assert.ok(near(notScored.y, scored.y + scored.h + NODE_GAP, EPS));
    assert.ok(notScored.h > scored.h, "the 860 never scored are visibly fatter than the 340 that were");

    const gate = node(l, "gate_passed");
    const gates = ["rejected::avoid", "rejected::no_price", "rejected::bundle_veto", "rejected::activity_floor", "rejected::mcap_ceiling", "rejected::stale"];
    const ys = gates.map((id) => node(l, id).y);
    assert.deepEqual([...ys].sort((a, b) => a - b), ys, "gate rejections ordered by count descending");
    assert.ok(near(ys[0], gate.y + gate.h + NODE_GAP, EPS), "first leak right under gate_passed");
    for (const id of gates) assert.equal(node(l, id).x, gate.x, `${id} in the gate_passed column`);
  });

  it("edges carry their target's colour, fade on rejection streams, and match node thickness", () => {
    const spine = edge(l, "ingested->scored");
    const leak = edge(l, "ingested->rejected::not_scored");
    assert.equal(spine.colorToken, "score");
    assert.equal(spine.opacity, SPINE_OPACITY);
    assert.equal(leak.colorToken, "reject");
    assert.equal(leak.opacity, BRANCH_OPACITY);
    assert.equal(edge(l, "scored->rejected::avoid").opacity, BRANCH_OPACITY);
    assert.equal(edge(l, "gate_passed->skipped::insufficient_balance").colorToken, "skipped");
    assert.equal(edge(l, "decision_committed->skipped::fill_rejected").opacity, BRANCH_OPACITY);
    assert.equal(edge(l, "entry->exit::stop_loss").colorToken, "reject");

    const r = ends(leak.path);
    const target = node(l, "rejected::not_scored");
    const source = node(l, "ingested");
    assert.ok(near(r.tTop, target.y) && near(r.tBot, target.y + target.h), "ribbon end tiles the rejection node");
    assert.ok(near(r.sBot - r.sTop, target.h), "the stream is the same thickness where it leaves");
    assert.ok(near(r.x1, source.x + source.w) && near(r.x2, target.x), "leaves the right side, enters the left side");
    assert.ok(near(r.c1x, r.x1 + (r.x2 - r.x1) / 2, 0.02) && near(r.c2x, r.x2 - (r.x2 - r.x1) / 2, 0.02), "control points at half the run");
  });

  it("outflows of a node stack spine-first and never leave its rect", () => {
    const source = node(l, "ingested");
    const out = ["ingested->scored", "ingested->rejected::not_scored"].map((id) => ends(edge(l, id).path));
    assert.ok(near(out[0].sTop, source.y));
    assert.ok(near(out[0].sBot, out[1].sTop), "contiguous");
    assert.ok(out[1].sBot <= source.y + source.h + 0.011);
  });

  it("is deterministic and independent of the order counts arrive in", () => {
    assert.deepEqual(layout(counts), l);
    assert.deepEqual(layout([...counts].reverse()), l);
  });

  it("stays bounded with counts in the millions", () => {
    const big = layout(counts.map((x) => ({ ...x, count: x.count * 2_500 })));
    assertWellFormed(big);
    assert.equal(big.nodes.length, l.nodes.length);
  });
});

describe("computeLayout: all branches present", () => {
  const counts = [
    c("ingested", null, 1000),
    c("rejected", "not_scored", 400),
    c("scored", null, 600),
    c("rejected", "avoid", 300),
    c("skipped", "already_in", 20),
    c("skipped", "max_positions", 15),
    c("rejected", "strictness", 12),
    c("rejected", "rug_label", 10),
    c("rejected", "no_price", 60),
    c("rejected", "curve_band", 25),
    c("rejected", "bundle_veto", 40),
    c("rejected", "age_limit", 18),
    c("rejected", "flow", 30),
    c("rejected", "smart_money", 5),
    c("rejected", "activity_floor", 22),
    c("rejected", "entry_filter", 14),
    c("rejected", "mcap_ceiling", 9),
    c("rejected", "stale", 6),
    c("gate_passed", null, 14),
    c("skipped", "insufficient_balance", 2),
    c("skipped", "live_blocked", 1),
    c("skipped", "micro_sim", 1),
    c("decision_committed", null, 10),
    c("skipped", "fill_rejected", 2),
    c("entry", "paper", 6),
    c("entry", "live", 2),
    c("exit", "take_profit", 2),
    c("exit", "trailing_stop", 2),
    c("exit", "flat_cut", 1),
    c("exit", "stop_loss", 1),
    c("exit", "max_hold", 1),
    c("exit", "forced_close", 1),
    c("outcome", null, 8),
  ];
  const l = layout(counts);
  const DOORS = ["exit::take_profit", "exit::trailing_stop", "exit::flat_cut", "exit::stop_loss", "exit::max_hold", "exit::forced_close"];

  it("draws every stage with its human label and colour token", () => {
    assertWellFormed(l);
    const expected: Record<string, [string, string]> = {
      ingested: ["Ingested", "ingest"],
      scored: ["Scored", "score"],
      gate_passed: ["Gate Passed", "pass"],
      decision_committed: ["Decision Committed", "pass"],
      entry: ["Entry", "pass"],
      "entry::paper": ["Paper", "pass"],
      "entry::live": ["Live", "pass"],
      outcome: ["Outcome", "pass"],
      "rejected::not_scored": ["Not scored", "reject"],
      "rejected::avoid": ["Avoided by scorer", "reject"],
      "skipped::already_in": ["Already in position", "skipped"],
      "skipped::max_positions": ["Max positions", "skipped"],
      "rejected::strictness": ["Signal strictness", "reject"],
      "rejected::rug_label": ["Rug label", "reject"],
      "rejected::no_price": ["No on-chain price", "reject"],
      "rejected::curve_band": ["Curve band", "reject"],
      "rejected::bundle_veto": ["Bundle veto", "reject"],
      "rejected::age_limit": ["Entry-age limit", "reject"],
      "rejected::flow": ["Order-flow gate", "reject"],
      "rejected::smart_money": ["Smart money required", "reject"],
      "rejected::activity_floor": ["Activity floor", "reject"],
      "rejected::entry_filter": ["Entry filter", "reject"],
      "rejected::mcap_ceiling": ["Market cap ceiling", "reject"],
      "rejected::stale": ["Stale >15s", "reject"],
      "skipped::insufficient_balance": ["Not enough balance", "skipped"],
      "skipped::live_blocked": ["Live blocked", "skipped"],
      "skipped::micro_sim": ["Slippage check", "skipped"],
      "skipped::fill_rejected": ["Fill rejected", "skipped"],
      "exit::take_profit": ["Take profit", "profit"],
      "exit::trailing_stop": ["Trailing stop", "trailing"],
      "exit::flat_cut": ["Flat cut", "reject"],
      "exit::stop_loss": ["Stop loss", "reject"],
      "exit::max_hold": ["Max hold", "reject"],
      "exit::forced_close": ["Forced close", "reject"],
    };
    assert.deepEqual(new Set(l.nodes.map((n) => n.id)), new Set(Object.keys(expected)));
    for (const [id, [label, token]] of Object.entries(expected)) {
      assert.equal(node(l, id).label, label, `${id} label`);
      assert.equal(node(l, id).colorToken, token, `${id} colour`);
    }
  });

  it("every branch hangs off the stage the worker applies it after", () => {
    const columnOf = (id: string) => Math.round((node(l, id).x + node(l, id).w / 2 - PAD) / STEP * 2) / 2;
    assert.equal(columnOf("rejected::not_scored"), 1);
    for (const id of ["rejected::avoid", "skipped::already_in", "skipped::max_positions", "rejected::no_price", "rejected::stale"]) {
      assert.equal(columnOf(id), 2, `${id} leaves scored`);
    }
    for (const id of ["skipped::insufficient_balance", "skipped::live_blocked", "skipped::micro_sim"]) {
      assert.equal(columnOf(id), 3, `${id} leaves gate_passed`);
    }
    assert.equal(columnOf("skipped::fill_rejected"), 4);
    for (const id of DOORS) assert.equal(columnOf(id), 4.5, `${id} between entry and outcome`);
  });

  it("entry is the sum of its lanes, and the lanes tile the entry rect", () => {
    const entry = node(l, "entry");
    const paper = node(l, "entry::paper");
    const live = node(l, "entry::live");
    assert.equal(entry.value, 8);
    assert.ok(paper.x === entry.x && live.x === entry.x);
    assert.ok(near(paper.y, entry.y, EPS) && near(paper.y + paper.h, live.y, EPS));
    assert.ok(near(live.y + live.h, entry.y + entry.h, EPS));
    assert.ok(paper.h > live.h, "paper carries three times the coins");
    assert.ok(live.h >= MIN_NODE_HEIGHT, "a 2-coin live lane keeps the floor even though entry is a sliver");
    assert.ok(!l.edges.some((e) => e.id === "decision_committed->entry"), "the stream splits straight into the lanes");
    assert.equal(edge(l, "decision_committed->entry::live").opacity, SPINE_OPACITY);
  });

  it("exit doors keep a fixed order and converge on outcome", () => {
    const doors = DOORS.map((id) => node(l, id));
    doors.slice(1).forEach((d, i) => assert.ok(d.y > doors[i].y, `${d.id} below ${doors[i].id}`));

    const outcome = node(l, "outcome");
    const inflows = doors.map((d) => ends(edge(l, `${d.id}->outcome`).path));
    assert.ok(near(inflows[0].tTop, outcome.y));
    inflows.slice(1).forEach((r, i) => assert.ok(near(r.tTop, inflows[i].tBot), "inflows stack contiguously"));
    assert.ok(near(inflows[inflows.length - 1].tBot, outcome.y + outcome.h), "and fill the outcome node exactly");
    assert.equal(edge(l, "exit::take_profit->outcome").colorToken, "pass");
    assert.equal(edge(l, "exit::take_profit->outcome").value, 2);
    assert.ok(!l.edges.some((e) => e.id === "entry->outcome"), "no bypass when doors exist");
  });

  it("has exactly the expected edges", () => {
    // ingested 2, scored 1 + 15 leaks, gate_passed 1 + 3, decision 2 lanes + 1, entry 6 doors + 6 into outcome
    assert.equal(l.edges.length, 37);
  });
});

describe("computeLayout: zero counts and orphans are skipped", () => {
  const l = layout([
    c("ingested", null, 100),
    c("scored", null, 60),
    c("rejected", "not_scored", 0),
    c("rejected", "avoid", 40),
    c("rejected", "age_limit", Number.NaN),
    c("rejected", "bundle_veto", -3),
    c("rejected", "activity_floor", 12),
    c("gate_passed", null, 0),
    c("skipped", "insufficient_balance", 3), // gate_passed is empty: an orphan
    c("decision_committed", null, 4),
    c("skipped", "fill_rejected", 0),
    c("exit", "take_profit", 5), // no entry in the window: an orphan
    c("outcome", null, 5),
  ]);

  it("emits no node or edge for zero, NaN or negative counts", () => {
    assertWellFormed(l);
    for (const id of ["rejected::not_scored", "rejected::age_limit", "rejected::bundle_veto", "skipped::fill_rejected", "gate_passed"]) {
      assert.ok(!l.nodes.some((n) => n.id === id), `no node for ${id}`);
      assert.ok(!l.edges.some((e) => e.source === id || e.target === id), `no edge for ${id}`);
    }
  });

  it("skips a branch whose parent stage has no count", () => {
    for (const id of ["exit::take_profit", "skipped::insufficient_balance", "entry"]) {
      assert.ok(!l.nodes.some((n) => n.id === id), `no node for ${id}`);
    }
  });

  it("keeps present spine stages but never bridges a missing one", () => {
    node(l, "decision_committed");
    node(l, "outcome");
    node(l, "rejected::activity_floor"); // scored is present, so its leak is drawn
    assert.ok(!l.edges.some((e) => e.id === "scored->decision_committed"));
    assert.deepEqual(
      l.edges.map((e) => e.id).sort(),
      ["ingested->scored", "scored->rejected::activity_floor", "scored->rejected::avoid"],
    );
  });

  it("merges duplicate rows for the same stage", () => {
    const merged = layout([c("ingested", null, 3), c("ingested", null, 4)]);
    assert.equal(node(merged, "ingested").value, 7);
  });

  it("draws an unlisted reason of a known family instead of hiding it", () => {
    const withManual = layout([
      c("entry", "paper", 4),
      c("exit", "take_profit", 1),
      c("exit", "manual_sell", 3),
      c("outcome", null, 4),
    ]);
    assertWellFormed(withManual);
    const manual = node(withManual, "exit::manual_sell");
    assert.equal(manual.label, "Manual Sell");
    assert.equal(manual.colorToken, "reject");
    assert.ok(manual.y > node(withManual, "exit::take_profit").y, "after the known doors");
    assert.equal(layout([c("mystery", "thing", 9)]).nodes.length, 0, "an unknown family is ignored");
  });
});

describe("computeLayout: a rejection count exceeds its parent", () => {
  // In a 5-minute window a later stage can count coins its parent saw before the window opened.
  const l = layout([c("ingested", null, 10), c("scored", null, 5), c("rejected", "not_scored", 50)]);

  it("does not throw and stays in bounds", () => {
    assertWellFormed(l);
  });

  it("the overfull column sets the scale and fills the height", () => {
    const leak = node(l, "rejected::not_scored");
    assert.ok(near(leak.y + leak.h, H - PAD, 1e-6));
    assert.ok(leak.h > node(l, "ingested").h * 4, "the 50-coin leak is drawn five times the 10-coin parent");
  });

  it("squeezes the streams inside the parent where they leave, full thickness where they land", () => {
    const parent = node(l, "ingested");
    const spine = ends(edge(l, "ingested->scored").path);
    const leak = ends(edge(l, "ingested->rejected::not_scored").path);
    assert.ok(near(spine.sTop, parent.y));
    assert.ok(near(leak.sBot, parent.y + parent.h), "the outflows fill the parent exactly, no further");
    const target = node(l, "rejected::not_scored");
    assert.ok(near(leak.tBot - leak.tTop, target.h));
    assert.ok(leak.tBot - leak.tTop > leak.sBot - leak.sTop, "the stream widens toward the leak");
  });
});
