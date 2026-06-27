import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRisk } from "./index";
import type { PaperRuntimeConfig } from "../config";

const config: PaperRuntimeConfig = {
  startSol: 10,
  maxOpenPositions: 3,
  maxPositionSol: 0.25,
  dailyLossLimitSol: 1,
  enableSlippage: true,
  enableFees: true,
  enableLatency: false,
  feeBps: 100,
  priorityFeeSol: 0.0005,
  baseSlippageBps: 30,
  latencyMinMs: 0,
  latencyMaxMs: 0,
  markToMarketMs: 10_000,
};

const baseSnapshot = { balanceSol: 5, realizedPnlSol: 0, openPositions: 0 };

test("risk: accepts within limits", () => {
  const r = checkRisk({
    notionalSol: 0.1,
    portfolio: baseSnapshot,
    todayLossSol: 0,
    config,
  });
  assert.equal(r.ok, true);
});

test("risk: rejects oversized position", () => {
  const r = checkRisk({
    notionalSol: 0.3,
    portfolio: baseSnapshot,
    todayLossSol: 0,
    config,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "OVER_MAX_POSITION");
});

test("risk: rejects insufficient balance", () => {
  const r = checkRisk({
    notionalSol: 0.2,
    portfolio: { ...baseSnapshot, balanceSol: 0.05 },
    todayLossSol: 0,
    config,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "INSUFFICIENT_BALANCE");
});

test("risk: rejects at max concurrent", () => {
  const r = checkRisk({
    notionalSol: 0.1,
    portfolio: { ...baseSnapshot, openPositions: 3 },
    todayLossSol: 0,
    config,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "MAX_CONCURRENT");
});

test("risk: rejects past daily loss cap", () => {
  const r = checkRisk({
    notionalSol: 0.1,
    portfolio: baseSnapshot,
    todayLossSol: 1.5,
    config,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "DAILY_LOSS_CAP");
});

test("risk: rejects zero/negative size", () => {
  assert.equal(checkRisk({ notionalSol: 0, portfolio: baseSnapshot, todayLossSol: 0, config }).ok, false);
  assert.equal(checkRisk({ notionalSol: -0.1, portfolio: baseSnapshot, todayLossSol: 0, config }).ok, false);
  assert.equal(checkRisk({ notionalSol: Number.NaN, portfolio: baseSnapshot, todayLossSol: 0, config }).ok, false);
});
