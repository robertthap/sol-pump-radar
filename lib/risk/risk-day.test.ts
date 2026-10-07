import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RISK_TIMEZONE, startOfRiskDay, riskDayWindow, riskDayKey, isSameRiskDay, dailyLossSol,
} from "@/lib/risk/risk-day";

/**
 * M02 — one risk-day definition, in Australia/Sydney, with partial losses and
 * fees counted.
 *
 * The bug: three queries all asked Postgres for `now()::date`, the SERVER's
 * calendar day. On a UTC server the day rolls at 10:00/11:00 Sydney — mid
 * trading day — so a bad morning and a bad afternoon counted as two days and
 * twice the intended risk was allowed through.
 */
const iso = (s: string) => new Date(s);

describe("risk day boundary (M02)", () => {
  it("rolls at Sydney midnight, not UTC midnight", () => {
    // 2026-06-15 is AEST (UTC+10): Sydney midnight is 14:00 UTC the day before.
    const during = iso("2026-06-15T05:00:00Z"); // 15:00 Sydney
    assert.equal(startOfRiskDay(during).toISOString(), "2026-06-14T14:00:00.000Z");
  });

  it("an instant just after UTC midnight is still the SAME Sydney day", () => {
    // This is the whole bug: 00:30 UTC is 10:30 Sydney, same trading day, but
    // `now()::date` on a UTC server had already rolled over.
    const beforeUtcMidnight = iso("2026-06-14T23:30:00Z"); // 09:30 Sydney 15th
    const afterUtcMidnight = iso("2026-06-15T00:30:00Z"); // 10:30 Sydney 15th
    assert.equal(riskDayKey(beforeUtcMidnight), "2026-06-15");
    assert.equal(riskDayKey(afterUtcMidnight), "2026-06-15");
    assert.equal(isSameRiskDay(afterUtcMidnight, beforeUtcMidnight), true);
  });

  it("handles AEDT, when Sydney is UTC+11", () => {
    // January is daylight saving: Sydney midnight is 13:00 UTC the day before.
    const during = iso("2026-01-15T05:00:00Z");
    assert.equal(startOfRiskDay(during).toISOString(), "2026-01-14T13:00:00.000Z");
  });

  it("a DST transition day is still exactly one day long, not 23 or 25 hours of confusion", () => {
    // Sydney DST begins Sun 4 Oct 2026 (02:00 -> 03:00): that local day is 23h.
    const dstStart = riskDayWindow(iso("2026-10-04T05:00:00Z"));
    const hours = (dstStart.end.getTime() - dstStart.start.getTime()) / 3_600_000;
    assert.equal(hours, 23, "the spring-forward day really is 23 hours");

    // Sydney DST ends Sun 5 Apr 2026 (03:00 -> 02:00): that local day is 25h.
    const dstEnd = riskDayWindow(iso("2026-04-05T05:00:00Z"));
    assert.equal((dstEnd.end.getTime() - dstEnd.start.getTime()) / 3_600_000, 25);
  });

  it("the window is half-open, so midnight belongs to exactly one day", () => {
    const w = riskDayWindow(iso("2026-06-15T05:00:00Z"));
    assert.equal(isSameRiskDay(w.start, w.start), true, "the first instant is inside");
    assert.equal(isSameRiskDay(w.end, w.start), false, "the last instant is NOT");
    // ...and it is the first instant of the next day.
    assert.equal(riskDayKey(w.end), "2026-06-16");
  });

  it("consecutive days tile without gap or overlap", () => {
    const a = riskDayWindow(iso("2026-10-03T05:00:00Z"));
    const b = riskDayWindow(new Date(a.end.getTime()));
    assert.equal(a.end.getTime(), b.start.getTime());
  });

  it("the timezone is Australia/Sydney, stated once", () => {
    assert.equal(RISK_TIMEZONE, "Australia/Sydney");
  });
});

describe("daily loss components (M02)", () => {
  const base = { closedPnlSol: [], partialPnlSol: [], feesWithoutPositionSol: [] };

  it("a losing day reports a positive loss magnitude", () => {
    assert.equal(dailyLossSol({ ...base, closedPnlSol: [-0.3, -0.2] }), 0.5);
  });

  it("PARTIAL closes count, which the old queries ignored entirely", () => {
    // A position that took a losing partial and had not yet fully closed
    // contributed nothing: the queries only looked at closed_at.
    assert.equal(dailyLossSol({ ...base, partialPnlSol: [-0.4] }), 0.4);
    assert.ok(
      dailyLossSol({ ...base, closedPnlSol: [-0.1], partialPnlSol: [-0.4] }) > 0.4,
      "both legs must count",
    );
  });

  it("fees on trades that produced no position still count", () => {
    // Failed transactions cost money and open nothing, so no closed_at exists.
    assert.ok(Math.abs(dailyLossSol({ ...base, feesWithoutPositionSol: [0.001, 0.002] }) - 0.003) < 1e-12);
  });

  it("profit inside the day offsets loss — the cap stops a RUNAWAY day", () => {
    assert.equal(dailyLossSol({ ...base, closedPnlSol: [5, -3] }), 0, "a net-up day has not run away");
    assert.equal(dailyLossSol({ ...base, closedPnlSol: [3, -5] }), 2);
  });

  it("a flat day is zero, not a tiny float", () => {
    assert.equal(dailyLossSol(base), 0);
    assert.equal(dailyLossSol({ ...base, closedPnlSol: [1, -1] }), 0);
  });

  it("non-finite values cannot poison the total", () => {
    assert.equal(dailyLossSol({ ...base, closedPnlSol: [-1, NaN, Infinity] }), 1);
  });
});
