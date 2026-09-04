import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { haltedNow, runHaltShutdown, type BreakerRead } from "@/lib/workers/halt-guard";
import type { CbState } from "@/lib/shared/types";

/**
 * A breaker whose state can change between reads, which is the whole scenario:
 * the auto-trader reads it once at the top of a tick and again immediately
 * before a fill, and the interesting case is a HALT raised in between.
 */
function breaker(initial: CbState) {
  let state = initial;
  const reads: CbState[] = [];
  const read: BreakerRead = async () => {
    reads.push(state);
    return { state };
  };
  return {
    read,
    reads,
    raiseHalt() {
      state = "HALTED";
    },
  };
}

describe("haltedNow — final pre-execution boundary", () => {
  it("does not block while the breaker is RUNNING", async () => {
    assert.equal(await haltedNow(breaker("RUNNING").read), false);
  });

  it("blocks when the breaker is HALTED", async () => {
    assert.equal(await haltedNow(breaker("HALTED").read), true);
  });

  it("only HALTED blocks — DEGRADED and PAUSED are the tick's business, not this gate", async () => {
    assert.equal(await haltedNow(breaker("DEGRADED").read), false);
    assert.equal(await haltedNow(breaker("PAUSED").read), false);
  });

  it("FAILS CLOSED: an unreadable breaker is treated as halted", async () => {
    const errors: unknown[] = [];
    const exploding: BreakerRead = async () => {
      throw new Error("db down");
    };
    assert.equal(await haltedNow(exploding, (e) => errors.push(e)), true);
    assert.equal(errors.length, 1);
  });

  it("reports the read failure even when no handler is supplied", async () => {
    const exploding: BreakerRead = async () => {
      throw new Error("db down");
    };
    assert.equal(await haltedNow(exploding), true);
  });
});

/**
 * TEST A — a trade that was eligible at approval time must not execute if HALT
 * is raised before the final boundary.
 *
 * The loop below mirrors both production call sites in
 * `lib/workers/auto-trader.ts` (`handleEntries` and `handleGenesisEntries`):
 * qualify -> build plan -> `if (await haltedNow()) break;` -> executePaperBuy.
 * The guard under test is the real one the auto-trader binds to `readState`.
 */
describe("HALT raised mid-tick blocks execution (Test A)", () => {
  async function entryPass(cb: ReturnType<typeof breaker>, candidates: string[]) {
    const executed: string[] = [];
    let abandoned = false;
    for (const mint of candidates) {
      // Approval + plan building — the external round-trips that open the window.
      const approved = true;
      if (!approved) continue;
      if (await haltedNow(cb.read)) {
        abandoned = true;
        break;
      }
      executed.push(mint);
    }
    return { executed, abandoned };
  }

  it("approved -> HALT -> final check -> rejected -> executePaperBuy is NOT performed", async () => {
    const cb = breaker("RUNNING");
    cb.raiseHalt(); // HALT lands after approval, before the boundary
    const { executed, abandoned } = await entryPass(cb, ["mintA"]);

    assert.deepEqual(executed, [], "no paper buy may be executed after a HALT");
    assert.equal(abandoned, true);
    assert.equal(cb.reads.length, 1, "the boundary must actually consult the breaker");
  });

  it("abandons the REST of the batch, not just the current candidate", async () => {
    const cb = breaker("RUNNING");
    cb.raiseHalt();
    const { executed } = await entryPass(cb, ["mintA", "mintB", "mintC"]);
    assert.deepEqual(executed, []);
  });

  it("executes normally when no HALT is raised (the gate is not simply closed)", async () => {
    const cb = breaker("RUNNING");
    const { executed, abandoned } = await entryPass(cb, ["mintA", "mintB"]);
    assert.deepEqual(executed, ["mintA", "mintB"]);
    assert.equal(abandoned, false);
  });

  it("stops at the candidate the HALT lands on, keeping earlier fills", async () => {
    const cb = breaker("RUNNING");
    const executed: string[] = [];
    for (const mint of ["mintA", "mintB", "mintC"]) {
      if (await haltedNow(cb.read)) break;
      executed.push(mint);
      if (mint === "mintA") cb.raiseHalt(); // HALT arrives after the first fill
    }
    assert.deepEqual(executed, ["mintA"]);
  });
});

/**
 * TEST B — HALT must not strand an already-open position. The final exit pass
 * runs BEFORE the session is retired.
 */
describe("HALT still runs exit management (Test B)", () => {
  it("HALT -> existing position -> exit handling still runs, then the session stops", async () => {
    const order: string[] = [];
    await runHaltShutdown({
      handleExits: async () => {
        order.push("handleExits");
      },
      stopSession: async () => {
        order.push("stopSession");
      },
    });
    assert.deepEqual(order, ["handleExits", "stopSession"]);
  });

  it("a failing exit pass is reported but does NOT block session retirement", async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    await runHaltShutdown({
      handleExits: async () => {
        order.push("handleExits");
        throw new Error("price resolver down");
      },
      stopSession: async () => {
        order.push("stopSession");
      },
      onExitError: (e) => errors.push(e),
    });
    assert.deepEqual(order, ["handleExits", "stopSession"]);
    assert.equal(errors.length, 1);
  });

  it("swallows the exit error even with no handler, so retirement still happens", async () => {
    let stopped = false;
    await runHaltShutdown({
      handleExits: async () => {
        throw new Error("boom");
      },
      stopSession: async () => {
        stopped = true;
      },
    });
    assert.equal(stopped, true);
  });
});
