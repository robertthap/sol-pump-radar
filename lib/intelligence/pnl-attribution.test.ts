import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attributePnl } from "@/lib/intelligence/pnl-attribution";

function approx(a: number, b: number, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
}

describe("attributePnl", () => {
  it("identity: edge + execution + market = pnl", () => {
    const a = attributePnl({ pnlSol: 0.02, sizeSol: 0.05, execSlippageBps: 40, rugDriven: false });
    approx(a.edgeSol + a.executionSol + a.marketSol, 0.02);
  });

  it("charges entry slippage to execution (a drag)", () => {
    const a = attributePnl({ pnlSol: 0.02, sizeSol: 0.05, execSlippageBps: 100, rugDriven: false });
    // 100 bps on 0.05 SOL = 0.0005 SOL cost
    approx(a.executionSol, -0.0005);
    approx(a.edgeSol, 0.02 + 0.0005);
    assert.equal(a.marketSol, 0);
  });

  it("attributes a rug loss to market, leaving edge ≈ 0", () => {
    const a = attributePnl({ pnlSol: -0.04, sizeSol: 0.05, execSlippageBps: 50, rugDriven: true });
    approx(a.edgeSol, 0);
    approx(a.executionSol, -(50 / 10_000) * 0.05);
    // market absorbs the rest of the loss
    approx(a.marketSol, -0.04 - a.executionSol);
  });

  it("a non-rug loss stays on edge (strategy owns it)", () => {
    const a = attributePnl({ pnlSol: -0.03, sizeSol: 0.05, execSlippageBps: 0, rugDriven: false });
    assert.equal(a.marketSol, 0);
    approx(a.edgeSol, -0.03);
  });

  it("ignores negative/invalid slippage and missing size", () => {
    const a = attributePnl({ pnlSol: 0.01, sizeSol: 0.05, execSlippageBps: -30, rugDriven: false });
    approx(a.executionSol, 0); // negative slippage is not a charged cost
    approx(a.edgeSol, 0.01);
  });
});
