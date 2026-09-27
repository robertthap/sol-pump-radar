import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logsNotificationFrom } from "@/lib/rpc/ws-manager";

// A real Solana logsNotification, shape as the RPC sends it: the slot is in
// `context`, and `value` carries only signature, err and logs.
const real = {
  context: { slot: 450902715 },
  value: {
    signature: "3Rb2KRxzP77AKMFEVfy5FAe3LZgiWmMML4aWcxzEfz1kgzR5Qz3Si57cfC4eesG9T7cP76irLhUseZFDgLoTyW83",
    err: null,
    logs: ["Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]"],
  },
};

describe("logsNotificationFrom", () => {
  it("takes the slot from context, where the RPC actually puts it", () => {
    // Read off `value` instead, this was undefined → every event stored at slot
    // 0 → fillState() asked for `decision_slot + delay` > 0 and always returned
    // null, so no paper position could ever open for any strategy.
    assert.equal(logsNotificationFrom(real)?.slot, 450902715);
  });

  it("carries signature and logs through untouched", () => {
    const n = logsNotificationFrom(real)!;
    assert.equal(n.signature, real.value.signature);
    assert.deepEqual(n.logs, real.value.logs);
    assert.equal(n.err, null);
  });

  it("falls back to a slot on value, for hand-built inputs", () => {
    const n = logsNotificationFrom({ value: { ...real.value, slot: 42 } });
    assert.equal(n?.slot, 42);
  });

  it("is 0, not undefined, when neither carries a slot", () => {
    assert.equal(logsNotificationFrom({ value: real.value })?.slot, 0);
  });

  it("returns null when there is no value to deliver", () => {
    assert.equal(logsNotificationFrom({ context: { slot: 1 } }), null);
    assert.equal(logsNotificationFrom(null), null);
    assert.equal(logsNotificationFrom(undefined), null);
  });
});
