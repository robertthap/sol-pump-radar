import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  composePortfolio,
  filterImportantLogs,
  pickPollMs,
  resolveSourceStatus,
  sparklineState,
  TICKER_STALE_MS,
} from "@/lib/auto/ticker-snapshot";

const open = [
  { sizeSol: 0.03, pnlSol: 0.0052 },
  { sizeSol: 0.03, pnlSol: -0.0014 },
  { sizeSol: 0.05, pnlSol: 0.0071 },
];

describe("composePortfolio - one source of truth", () => {
  it("hero unrealized EQUALS the sum of the rows (the invariant)", () => {
    const p = composePortfolio(open, 0.01, 9.5);
    const sum = open.reduce((s, r) => s + (r.pnlSol ?? 0), 0);
    assert.ok(Math.abs(p.unrealizedPnlSol - sum) < 1e-9);
  });

  it("investedSol is the sum of position sizes", () => {
    assert.ok(Math.abs(composePortfolio(open, 0, null).investedSol - 0.11) < 1e-12);
  });

  it("currentValueSol = invested + unrealized", () => {
    const p = composePortfolio(open, 0, null);
    assert.ok(Math.abs(p.currentValueSol - (p.investedSol + p.unrealizedPnlSol)) < 1e-12);
  });

  it("unrealizedPct is unrealized over invested", () => {
    const p = composePortfolio(open, 0, null);
    assert.ok(Math.abs(p.unrealizedPct - p.unrealizedPnlSol / 0.11) < 1e-12);
  });

  it("totalPnlSol = realized + unrealized", () => {
    const p = composePortfolio(open, 0.02, null);
    assert.ok(Math.abs(p.totalPnlSol - (0.02 + p.unrealizedPnlSol)) < 1e-12);
  });

  it("zero positions -> everything zero, pct does not divide by zero", () => {
    assert.deepEqual(composePortfolio([], 0.4, 10), {
      investedSol: 0,
      currentValueSol: 0,
      availableSol: 10,
      unrealizedPnlSol: 0,
      unrealizedPct: 0,
      realizedPnlSol: 0.4,
      totalPnlSol: 0.4,
      openCount: 0,
      unpricedCount: 0,
    });
  });

  it("a null pnlSol row counts as invested but not as P&L, and is reported", () => {
    const p = composePortfolio([{ sizeSol: 0.03, pnlSol: null }, ...open], 0, null);
    assert.ok(Math.abs(p.investedSol - 0.14) < 1e-12);
    assert.equal(p.unpricedCount, 1);
    const sum = open.reduce((s, r) => s + (r.pnlSol ?? 0), 0);
    assert.ok(Math.abs(p.unrealizedPnlSol - sum) < 1e-9);
  });

  it("non-finite realized is treated as 0 rather than poisoning the total", () => {
    assert.equal(composePortfolio(open, Number.NaN, null).realizedPnlSol, 0);
  });
});

describe("filterImportantLogs - important events only", () => {
  const base = { mint: "m", symbol: "DOGE", pnlSol: null, source: "paper" as const };
  const entries = [
    { id: "1", ts: "2026-09-05T12:00:01Z", kind: "skip", message: "confluence too low", ...base },
    { id: "2", ts: "2026-09-05T12:00:02Z", kind: "open", message: "opened 0.03 SOL", ...base },
    { id: "3", ts: "2026-09-05T12:00:03Z", kind: "skip", message: "too new", ...base },
    { id: "4", ts: "2026-09-05T12:00:04Z", kind: "tp1", message: "partial take-profit", ...base, pnlSol: 0.004 },
    { id: "5", ts: "2026-09-05T12:00:05Z", kind: "close", message: "take-profit", ...base, pnlSol: 0.052 },
    { id: "6", ts: "2026-09-05T12:00:06Z", kind: "skip", message: "session stopped: daily loss cap", ...base, source: "system" as const },
    { id: "7", ts: "2026-09-05T12:00:07Z", kind: "close", message: "trading HALTED by operator", ...base, source: "system" as const },
  ];

  it("drops every skip, keeps open/close/tp1", () => {
    const kinds = filterImportantLogs(entries).map((e) => e.kind as string);
    assert.ok(!kinds.includes("skip"));
    assert.ok(kinds.includes("open"));
    assert.ok(kinds.includes("close"));
    assert.ok(kinds.includes("tp1"));
  });

  it("a skip is dropped even when it is a system message", () => {
    assert.ok(!filterImportantLogs(entries).some((e) => e.id === "6"));
  });

  it("returns newest first and honours the cap", () => {
    const out = filterImportantLogs(entries, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.id, "7");
    assert.equal(out[1]!.id, "5");
  });

  it("classifies system messages: halt / session / error, drops tick noise", () => {
    const sys = (msg: string) => ({ id: msg, ts: "t", kind: "info", message: msg, ...base, source: "system" as const });
    const out = filterImportantLogs([
      sys("trading HALTED"),
      sys("auto-trade stopped: daily loss cap reached"),
      sys("sell failed: rpc timeout"),
      sys("tick 42 pending=3"),
    ]);
    assert.deepEqual(out.map((e) => e.kind).sort(), ["error", "halt", "session"]);
  });
});

describe("pickPollMs - polling policy", () => {
  it("visible + open positions -> 1 s", () => {
    assert.equal(pickPollMs({ visible: true, openCount: 3, botRunning: true, hasSession: true }), 1_000);
  });
  it("visible + bot running + no positions -> 5 s", () => {
    assert.equal(pickPollMs({ visible: true, openCount: 0, botRunning: true, hasSession: true }), 5_000);
  });
  it("hidden -> no polling, whatever else is true", () => {
    assert.equal(pickPollMs({ visible: false, openCount: 3, botRunning: true, hasSession: true }), 0);
  });
  it("stopped with nothing open -> no polling", () => {
    assert.equal(pickPollMs({ visible: true, openCount: 0, botRunning: false, hasSession: true }), 0);
    assert.equal(pickPollMs({ visible: true, openCount: 0, botRunning: false, hasSession: false }), 0);
  });
  it("stopped but positions still open -> 5 s so the orphan sweep is visible", () => {
    assert.equal(pickPollMs({ visible: true, openCount: 2, botRunning: false, hasSession: true }), 5_000);
  });
});

describe("resolveSourceStatus", () => {
  const ok = { hasSession: true, sessionActive: true, breaker: "RUNNING", workerAlive: true, snapshotAgeMs: 800 };
  it("live when everything is fresh", () => assert.equal(resolveSourceStatus(ok), "live"));
  it("stale past the threshold", () =>
    assert.equal(resolveSourceStatus({ ...ok, snapshotAgeMs: TICKER_STALE_MS + 1 }), "stale"));
  it("offline beats everything - a dead worker can show no live number", () =>
    assert.equal(resolveSourceStatus({ ...ok, workerAlive: false, breaker: "HALTED" }), "offline"));
  it("halted beats session state", () =>
    assert.equal(resolveSourceStatus({ ...ok, breaker: "HALTED", hasSession: false }), "halted"));
  it("no_session / stopped", () => {
    assert.equal(resolveSourceStatus({ ...ok, hasSession: false }), "no_session");
    assert.equal(resolveSourceStatus({ ...ok, sessionActive: false }), "stopped");
  });
});

describe("sparklineState", () => {
  it("positive / negative / flat / empty", () => {
    assert.equal(sparklineState([0.01, 0.02, 0.05]), "positive");
    assert.equal(sparklineState([0.01, -0.02]), "negative");
    assert.equal(sparklineState([0.03, 0]), "flat");
    assert.equal(sparklineState([]), "empty");
  });
});
