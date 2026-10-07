import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRisk, paperConfigFromEnv, type RiskCheckInput } from "@spr/trading";

/**
 * H09 / H10 (paper part) — refuse NEW entries when the data or the account says
 * so, while exits keep being managed.
 *
 * Before this, checkRisk knew about size, balance, open-position count and the
 * daily loss cap, and nothing else. It would happily open a position on a feed
 * that had gone quiet, while the breaker was PAUSED or DEGRADED (only HALTED
 * blocked, and only in the worker tick), at any depth of drawdown, and with
 * unlimited exposure to a single mint.
 */
const config = {
  ...paperConfigFromEnv({} as NodeJS.ProcessEnv),
  maxPositionSol: 1,
  maxOpenPositions: 5,
  dailyLossLimitSol: 10,
};

const ok: RiskCheckInput = {
  notionalSol: 0.1,
  portfolio: { balanceSol: 10, realizedPnlSol: 0, openPositions: 0 },
  todayLossSol: 0,
  config,
  breakerState: "RUNNING",
  dataAgeMs: 500,
  feedDegraded: false,
  equitySol: 10,
  peakEquitySol: 10,
  mintOpenNotionalSol: 0,
};

const codeOf = (over: Partial<RiskCheckInput>) => {
  const r = checkRisk({ ...ok, ...over });
  return r.ok ? null : r.code;
};

describe("paper entry gates (H09)", () => {
  it("a healthy request still passes — the gates must not block everything", () => {
    assert.equal(checkRisk(ok).ok, true);
  });

  it("blocks on every non-RUNNING breaker state, not just HALTED", () => {
    assert.equal(codeOf({ breakerState: "HALTED" }), "BREAKER");
    assert.equal(codeOf({ breakerState: "PAUSED" }), "BREAKER");
    assert.equal(codeOf({ breakerState: "DEGRADED" }), "BREAKER");
    assert.equal(codeOf({ breakerState: "RUNNING" }), null);
  });

  it("blocks when the feed is explicitly degraded", () => {
    assert.equal(codeOf({ feedDegraded: true }), "FEED_DEGRADED");
  });

  it("blocks on stale data, and treats UNKNOWN age as stale", () => {
    assert.equal(codeOf({ dataAgeMs: config.maxDataStalenessMs + 1 }), "STALE_DATA");
    assert.equal(
      codeOf({ dataAgeMs: null }), "STALE_DATA",
      "no age means we cannot vouch for the data — that is not the same as fresh",
    );
    assert.equal(codeOf({ dataAgeMs: config.maxDataStalenessMs - 1 }), null);
  });

  it("blocks past the peak-to-trough drawdown limit", () => {
    const peak = 10;
    const limit = config.maxDrawdownPct;
    // Just inside the limit is allowed; just past it is not.
    assert.equal(codeOf({ peakEquitySol: peak, equitySol: peak * (1 - limit) + 1e-9 }), null);
    assert.equal(codeOf({ peakEquitySol: peak, equitySol: peak * (1 - limit) - 1e-9 }), "DRAWDOWN");
  });

  it("drawdown is measured from the PEAK, not from the starting balance", () => {
    // Up to 20 then back to 11: still above the 10 it started with, but 45% off
    // the peak. Measuring from the start would call this a profit.
    assert.equal(codeOf({ peakEquitySol: 20, equitySol: 11 }), "DRAWDOWN");
  });

  it("a peak of zero or less cannot divide by zero into a false block", () => {
    assert.equal(codeOf({ peakEquitySol: 0, equitySol: 0 }), null);
  });

  it("H10: blocks when this mint already holds the per-token limit", () => {
    assert.equal(
      codeOf({ mintOpenNotionalSol: config.maxPerMintSol }), "MAX_PER_MINT",
    );
    assert.equal(
      codeOf({ notionalSol: 0.1, mintOpenNotionalSol: config.maxPerMintSol - 0.05 }),
      "MAX_PER_MINT",
      "the NEW position's size counts toward the limit, not just what is already open",
    );
    assert.equal(codeOf({ mintOpenNotionalSol: 0 }), null);
  });

  it("the original limits still apply", () => {
    assert.equal(codeOf({ notionalSol: 0 }), "BAD_SIZE");
    assert.equal(codeOf({ notionalSol: 99 }), "OVER_MAX_POSITION");
    assert.equal(codeOf({ notionalSol: 0.9, portfolio: { ...ok.portfolio, balanceSol: 0.5 } }), "INSUFFICIENT_BALANCE");
    assert.equal(codeOf({ portfolio: { ...ok.portfolio, openPositions: 5 } }), "MAX_CONCURRENT");
    assert.equal(codeOf({ todayLossSol: 10 }), "DAILY_LOSS_CAP");
  });

  it("omitting the new inputs does not silently open the gates", () => {
    // Callers not yet passing the new fields must FAIL CLOSED on the ones that
    // represent unknown health, not be waved through.
    const bare = {
      notionalSol: 0.1,
      portfolio: ok.portfolio,
      todayLossSol: 0,
      config,
    } as RiskCheckInput;
    assert.equal(checkRisk(bare).ok, false, "unknown feed health must not pass");
  });
});
