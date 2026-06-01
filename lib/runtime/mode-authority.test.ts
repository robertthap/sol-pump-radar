import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateModeRequest,
  signModeActivation,
  type ModeAuthorityContext,
  type ModeRequest,
} from "@/lib/runtime/mode-authority";

const CONFIRM = "I_UNDERSTAND_REAL_MONEY";

function ctx(over: Partial<ModeAuthorityContext> = {}): ModeAuthorityContext {
  return {
    currentActive: "demo",
    walletUnlocked: true,
    capsConfigured: true,
    requiredConfirm: CONFIRM,
    walletId: "W1",
    sessionId: "S1",
    nowMs: 10_000,
    maxAgeMs: 30_000,
    ...over,
  };
}
function req(over: Partial<ModeRequest> = {}): ModeRequest {
  return { requestId: "r1", mode: "real", confirmPhrase: CONFIRM, createdAtMs: 9_000, ...over };
}

describe("evaluateModeRequest", () => {
  it("activates real with confirm + wallet + caps, and signs it", () => {
    const d = evaluateModeRequest(req(), ctx());
    assert.equal(d.accept, true);
    assert.equal(d.nextActive, "real");
    assert.ok(d.signature && d.signature.startsWith("m_"));
  });

  it("rejects demo→real without the confirm phrase", () => {
    const d = evaluateModeRequest(req({ confirmPhrase: "nope" }), ctx());
    assert.equal(d.accept, false);
    assert.equal(d.nextActive, "demo");
    assert.match(d.reason, /confirm/);
  });

  it("rejects demo→real when wallet is locked", () => {
    const d = evaluateModeRequest(req(), ctx({ walletUnlocked: false }));
    assert.equal(d.accept, false);
    assert.match(d.reason, /wallet locked/);
  });

  it("rejects demo→real when caps are not configured", () => {
    const d = evaluateModeRequest(req(), ctx({ capsConfigured: false }));
    assert.equal(d.accept, false);
    assert.match(d.reason, /caps/);
  });

  it("always allows real→demo (safe direction), no signature needed", () => {
    const d = evaluateModeRequest(req({ mode: "demo", confirmPhrase: undefined }), ctx({ currentActive: "real" }));
    assert.equal(d.accept, true);
    assert.equal(d.nextActive, "demo");
    assert.equal(d.signature, null);
  });

  it("rejects a stale request", () => {
    const d = evaluateModeRequest(req({ createdAtMs: 0 }), ctx({ nowMs: 100_000 }));
    assert.equal(d.accept, false);
    assert.match(d.reason, /stale/);
  });

  it("rejects a replayed request id", () => {
    const d = evaluateModeRequest(req({ requestId: "dup" }), ctx({ lastRequestId: "dup" }));
    assert.equal(d.accept, false);
    assert.match(d.reason, /replay/);
  });

  it("treats same-mode request as an accepted no-op", () => {
    const d = evaluateModeRequest(req({ mode: "demo" }), ctx({ currentActive: "demo" }));
    assert.equal(d.accept, true);
    assert.equal(d.nextActive, "demo");
  });

  it("signature is deterministic for identical inputs", () => {
    const a = signModeActivation({ walletId: "W", sessionId: "S", nowMs: 5, mode: "real" });
    const b = signModeActivation({ walletId: "W", sessionId: "S", nowMs: 5, mode: "real" });
    assert.equal(a, b);
  });
});
