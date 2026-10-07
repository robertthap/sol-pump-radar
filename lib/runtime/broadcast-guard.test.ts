import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mayBroadcast, assertMayBroadcast, LiveBroadcastBlocked, LIVE_CONFIRM_TOKEN,
  type BroadcastFlags,
} from "@/lib/runtime/broadcast-guard";

/**
 * Group 3 — one central guard proving no code path can send a real transaction
 * while LIVE is off.
 *
 * The property under test is NEGATIVE: of every configuration, exactly one
 * shape may broadcast. So the tests enumerate rather than spot-check, and the
 * exhaustive case below is the one that would catch a future flag being added
 * with a permissive default.
 */
const LIVE: BroadcastFlags = {
  runtimeProfile: "live",
  liveExecution: "on",
  liveDryRun: "off",
  liveConfirm: LIVE_CONFIRM_TOKEN,
};

describe("central broadcast guard", () => {
  it("allows exactly the fully confirmed live configuration", () => {
    assert.equal(mayBroadcast(LIVE).allowed, true);
    assert.doesNotThrow(() => assertMayBroadcast(LIVE));
  });

  it("a dry run NEVER broadcasts, even when everything else says live", () => {
    // The worst failure available here: the operator believes nothing can happen.
    const v = mayBroadcast({ ...LIVE, liveDryRun: "on" });
    assert.equal(v.allowed, false);
    assert.equal(v.reason, "live_dry_run_on");
  });

  it("blocks the paper_safe profile the project actually runs", () => {
    assert.equal(mayBroadcast({ ...LIVE, runtimeProfile: "paper_safe" }).allowed, false);
  });

  it("blocks when LIVE_EXECUTION is off, and when the confirm token is wrong", () => {
    assert.equal(mayBroadcast({ ...LIVE, liveExecution: "off" }).allowed, false);
    assert.equal(mayBroadcast({ ...LIVE, liveConfirm: "yes" }).allowed, false);
    assert.equal(mayBroadcast({ ...LIVE, liveConfirm: undefined }).allowed, false);
  });

  it("FAILS CLOSED on anything unset or unrecognised", () => {
    const unset: BroadcastFlags = {
      runtimeProfile: undefined, liveExecution: undefined,
      liveDryRun: undefined, liveConfirm: undefined,
    };
    assert.equal(mayBroadcast(unset).allowed, false);
    // Truthy-looking values that are not the exact expected strings.
    assert.equal(mayBroadcast({ ...LIVE, liveExecution: "true" }).allowed, false);
    assert.equal(mayBroadcast({ ...LIVE, liveExecution: "ON" }).allowed, false);
    assert.equal(mayBroadcast({ ...LIVE, runtimeProfile: "LIVE" }).allowed, false);
  });

  it("exhaustive: of every flag combination, only one may broadcast", () => {
    const profiles = ["live", "paper_safe", "dev", "", undefined];
    const onOff = ["on", "off", "", undefined];
    const confirms = [LIVE_CONFIRM_TOKEN, "", "yes", undefined];
    let allowedCount = 0;
    let total = 0;
    for (const runtimeProfile of profiles) {
      for (const liveExecution of onOff) {
        for (const liveDryRun of onOff) {
          for (const liveConfirm of confirms) {
            total++;
            const v = mayBroadcast({ runtimeProfile, liveExecution, liveDryRun, liveConfirm });
            if (v.allowed) {
              allowedCount++;
              // Whatever is allowed must be exactly the live shape.
              assert.equal(runtimeProfile, "live");
              assert.equal(liveExecution, "on");
              assert.notEqual(liveDryRun, "on");
              assert.equal(liveConfirm, LIVE_CONFIRM_TOKEN);
            }
          }
        }
      }
    }
    assert.ok(total >= 300, `expected a broad sweep, got ${total}`);
    // live x on x {off,"",undefined} x token  = 3 permitted combinations.
    assert.equal(allowedCount, 3, `${allowedCount} of ${total} combinations could broadcast`);
  });

  it("throws a guard-specific error, not something a catch would mistake for RPC trouble", () => {
    assert.throws(
      () => assertMayBroadcast({ ...LIVE, liveExecution: "off" }),
      (e: unknown) => {
        assert.ok(e instanceof LiveBroadcastBlocked);
        assert.equal((e as LiveBroadcastBlocked).reason, "live_execution_off");
        assert.match((e as Error).message, /refusing to broadcast/i);
        return true;
      },
    );
  });
});

/**
 * The guard is only worth anything if it is installed AT the choke point.
 * rpcSendBase64 is the single place a signed transaction reaches the network.
 */
describe("the guard is installed at the broadcast choke point", () => {
  it("the live executor refuses to broadcast under this repo's default config", async () => {
    // Defaults are RUNTIME_PROFILE=paper_safe, LIVE_EXECUTION=off, LIVE_DRY_RUN=on.
    // The URL is deliberately unroutable: if the guard were ever removed, this
    // would fail with a fetch error instead, and the assertion below would catch
    // that the refusal is no longer the guard's doing.
    const { rpcSendBase64 } = await import("@/lib/executor/live");
    await assert.rejects(
      () => rpcSendBase64("http://127.0.0.1:1/never", "AA=="),
      (e: unknown) => {
        assert.ok(
          e instanceof LiveBroadcastBlocked,
          `expected the central guard to block, got: ${String(e)}`,
        );
        return true;
      },
    );
  });
});
