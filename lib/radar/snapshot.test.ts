import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "@/lib/radar/layout";
import {
  SAMPLES_PER_STAGE,
  composeRadarSnapshot,
  exitSubStage,
  parseRadarWindow,
  type GateRow,
  type PositionRow,
  type SnapshotRows,
} from "@/lib/radar/snapshot";

const T0 = Date.parse("2026-09-13T12:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const META = { window: "5m" as const, generatedAt: at(300), bot: { running: true, mode: "paper" as const, workerAlive: true } };
const empty: SnapshotRows = { ingested: [], scored: [], gates: [], positions: [] };

const gate = (mint: string, s: number, stage: GateRow["stage"], sub_stage: string | null = null, detail: string | null = null): GateRow => ({
  mint,
  ts: at(s),
  stage,
  sub_stage,
  score: 0.5,
  detail,
});

const position = (over: Partial<PositionRow>): PositionRow => ({
  mint: "P",
  lane: "paper",
  openedAt: at(10),
  closedAt: null,
  openedInWindow: true,
  closedInWindow: false,
  exitReason: null,
  pnlSol: null,
  score: 0.6,
  dryRun: false,
  ...over,
});

const countOf = (snap: ReturnType<typeof composeRadarSnapshot>, stage: string, sub: string | null = null) =>
  snap.counts.find((c) => c.stage === stage && c.sub_stage === sub)?.count ?? 0;

describe("parseRadarWindow", () => {
  it("accepts the four windows and defaults to 5 minutes", () => {
    assert.deepEqual(parseRadarWindow("1m"), { key: "1m", seconds: 60 });
    assert.deepEqual(parseRadarWindow("1h"), { key: "1h", seconds: 3600 });
    assert.deepEqual(parseRadarWindow(null), { key: "5m", seconds: 300 });
    assert.deepEqual(parseRadarWindow("7d"), { key: "5m", seconds: 300 });
    assert.deepEqual(parseRadarWindow("toString"), { key: "5m", seconds: 300 });
  });
});

describe("exitSubStage: stored close reasons map to exit doors", () => {
  it("maps the exit policy's codes, with or without a partial take-profit first", () => {
    assert.equal(exitSubStage("tp"), "take_profit");
    assert.equal(exitSubStage("trail"), "trailing_stop");
    assert.equal(exitSubStage("trail+tp1"), "trailing_stop");
    assert.equal(exitSubStage("stagnation"), "flat_cut");
    assert.equal(exitSubStage("sl"), "stop_loss");
    assert.equal(exitSubStage("sl+tp1"), "stop_loss");
    assert.equal(exitSubStage("timeout"), "max_hold");
  });

  it("closes the bot did not choose are forced", () => {
    for (const r of ["session_ended", "timeout_stale", "worker_restart", "manual_auto_sell_all", "manual_sell", null, ""]) {
      assert.equal(exitSubStage(r), "forced_close", String(r));
    }
  });
});

describe("composeRadarSnapshot: scoring", () => {
  it("coins ingested without a score leak as not scored; AVOID verdicts leak with the scorer's reason", () => {
    const snap = composeRadarSnapshot(
      {
        ...empty,
        ingested: [{ mint: "A", ts: at(1) }, { mint: "B", ts: at(2) }, { mint: "C", ts: at(3) }],
        scored: [
          { mint: "A", ts: at(5), score: 0.7, bought: true, avoidReason: null },
          { mint: "B", ts: at(6), score: 0.81, bought: false, avoidReason: "rug risk 0.9" },
          { mint: "OLD", ts: at(7), score: 0.4, bought: true, avoidReason: null },
        ],
      },
      META,
    );
    assert.equal(countOf(snap, "ingested"), 3);
    assert.equal(countOf(snap, "rejected", "not_scored"), 1);
    assert.equal(countOf(snap, "scored"), 3, "a coin first seen before the window still counts as scored in it");
    assert.equal(countOf(snap, "rejected", "avoid"), 1);
    const avoided = snap.samples.find((s) => s.sub_stage === "avoid");
    assert.equal(avoided?.mint, "B");
    assert.equal(avoided?.detail, "rug risk 0.9");
    assert.equal(snap.samples.find((s) => s.stage === "ingested" && s.mint === "A")?.score, 0.7, "ingested samples carry the score when known");
  });
});

describe("composeRadarSnapshot: gates", () => {
  const snap = composeRadarSnapshot(
    {
      ...empty,
      gates: [
        // A: refused for no price, passes a tick later -> passed only
        gate("A", 10, "rejected", "no_price"),
        gate("A", 13, "gate_passed"),
        gate("A", 13, "decision_committed"),
        // B: two different refusals -> counted once, at the latest gate
        gate("B", 10, "rejected", "mcap_ceiling"),
        gate("B", 40, "rejected", "no_price", "no on-chain price: RPC unavailable"),
        // C: passes the gates, then not enough balance -> passed and skipped
        gate("C", 20, "gate_passed"),
        gate("C", 20, "skipped", "insufficient_balance"),
        // D: not enough balance, later passes and commits -> no skip
        gate("D", 20, "gate_passed"),
        gate("D", 20, "skipped", "insufficient_balance"),
        gate("D", 50, "gate_passed"),
        gate("D", 50, "decision_committed"),
        // E: committed, fill rejected -> both
        gate("E", 30, "gate_passed"),
        gate("E", 30, "decision_committed"),
        gate("E", 31, "skipped", "fill_rejected"),
        // F: already holding it, after an earlier entry -> passed earlier and skipped now
        gate("F", 5, "gate_passed"),
        gate("F", 60, "skipped", "already_in"),
      ],
    },
    META,
  );

  it("counts each coin once per pass stage", () => {
    assert.equal(countOf(snap, "gate_passed"), 5);
    assert.equal(countOf(snap, "decision_committed"), 3);
  });

  it("counts a refused coin once, at the last gate it hit, unless it got further afterwards", () => {
    assert.equal(countOf(snap, "rejected", "no_price"), 1);
    assert.equal(countOf(snap, "rejected", "mcap_ceiling"), 0);
    assert.equal(snap.samples.find((s) => s.sub_stage === "no_price")?.mint, "B");
    assert.equal(snap.samples.find((s) => s.sub_stage === "no_price")?.detail, "no on-chain price: RPC unavailable");
    assert.equal(countOf(snap, "skipped", "insufficient_balance"), 1);
    assert.equal(snap.samples.find((s) => s.sub_stage === "insufficient_balance")?.mint, "C");
    assert.equal(countOf(snap, "skipped", "fill_rejected"), 1);
    assert.equal(countOf(snap, "skipped", "already_in"), 1);
    assert.equal(snap.totals.stopped, 4);
  });
});

describe("composeRadarSnapshot: positions", () => {
  const snap = composeRadarSnapshot(
    {
      ...empty,
      positions: [
        position({ mint: "OPEN" }),
        position({ mint: "WIN", closedAt: at(100), closedInWindow: true, exitReason: "tp", pnlSol: 0.02 }),
        position({ mint: "LOSS", lane: "live", openedInWindow: false, openedAt: at(-900), closedAt: at(120), closedInWindow: true, exitReason: "sl+tp1", pnlSol: -0.01, dryRun: true }),
      ],
    },
    META,
  );

  it("entries split by lane and include positions held from before the window", () => {
    assert.equal(countOf(snap, "entry", "paper"), 2);
    assert.equal(countOf(snap, "entry", "live"), 1);
    assert.equal(snap.samples.find((s) => s.mint === "LOSS" && s.stage === "entry")?.detail, "held from earlier · dry-run");
  });

  it("closes go through their exit door into the outcome, with P&L", () => {
    assert.equal(countOf(snap, "exit", "take_profit"), 1);
    assert.equal(countOf(snap, "exit", "stop_loss"), 1);
    assert.equal(countOf(snap, "outcome"), 2);
    assert.equal(snap.samples.find((s) => s.stage === "outcome" && s.mint === "WIN")?.pnl_sol, 0.02);
    assert.deepEqual(
      { traded: snap.totals.traded, open: snap.totals.open, closed: snap.totals.closed, won: snap.totals.won, lost: snap.totals.lost },
      { traded: 2, open: 1, closed: 2, won: 1, lost: 1 },
    );
    assert.ok(Math.abs(snap.totals.realizedPnlSol - 0.01) < 1e-12);
  });
});

describe("composeRadarSnapshot: output", () => {
  const many: SnapshotRows = {
    ...empty,
    ingested: Array.from({ length: 60 }, (_, i) => ({ mint: `M${i}`, ts: at(i) })),
  };

  it("keeps the newest samples per stage and every count", () => {
    const snap = composeRadarSnapshot(many, META);
    const ingested = snap.samples.filter((s) => s.stage === "ingested");
    assert.equal(ingested.length, SAMPLES_PER_STAGE);
    assert.equal(ingested[0].mint, "M59");
    assert.equal(countOf(snap, "ingested"), 60);
    assert.equal(snap.totals.entered, 60);
  });

  it("is deterministic regardless of row order", () => {
    const a = composeRadarSnapshot(many, META);
    const b = composeRadarSnapshot({ ...many, ingested: [...many.ingested].reverse() }, META);
    assert.deepEqual(a.counts, b.counts);
  });

  it("feeds the layout: every counted stage with a drawn parent gets a node", () => {
    const snap = composeRadarSnapshot(
      {
        ingested: [{ mint: "A", ts: at(1) }, { mint: "B", ts: at(1) }],
        scored: [{ mint: "A", ts: at(2), score: 0.6, bought: true, avoidReason: null }],
        gates: [gate("A", 3, "gate_passed"), gate("A", 3, "decision_committed")],
        positions: [position({ mint: "A", closedAt: at(200), closedInWindow: true, exitReason: "stagnation", pnlSol: -0.001 })],
      },
      META,
    );
    const l = computeLayout({ counts: snap.counts, width: 1000, height: 500 });
    const ids = l.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, [
      "decision_committed",
      "entry",
      "entry::paper",
      "exit::flat_cut",
      "gate_passed",
      "ingested",
      "outcome",
      "rejected::not_scored",
      "scored",
    ]);
  });
});
