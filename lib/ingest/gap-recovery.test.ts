import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recoverGapForMints, type RpcClient, type AtRiskMint } from "./gap-recovery";

type SigPage = Array<{ signature: string; slot: number; blockTime: number | null }>;

function makeMockRpc(opts: {
  /** Map of pda → ordered (newest→oldest) signatures. */
  sigsByPda: Map<string, SigPage>;
  /** Override txs for specific signatures (default = empty logMessages, decoder returns []). */
  txByCount?: Map<string, { logs: string[] | null; err?: unknown } | null>;
  /** Throw when called on this pda. */
  throwsOn?: Set<string>;
  /** Counters the test can inspect after running. */
  counts?: { sigCalls: number; txCalls: number; getTxForSlot: number[] };
}): RpcClient {
  const counts = opts.counts ?? { sigCalls: 0, txCalls: 0, getTxForSlot: [] };
  return {
    async getSignaturesForAddress(addr, q) {
      counts.sigCalls++;
      if (opts.throwsOn?.has(addr)) throw new Error("simulated RPC failure");
      const all = opts.sigsByPda.get(addr) ?? [];
      // Honor `before` cursor: include items AFTER the cursor's index (older).
      let startIdx = 0;
      if (q?.before) {
        const idx = all.findIndex((s) => s.signature === q.before);
        startIdx = idx >= 0 ? idx + 1 : 0;
      }
      const lim = q?.limit ?? 100;
      let slice = all.slice(startIdx, startIdx + lim);
      // Honor `until`: stop when we hit it (drop it and anything older).
      if (q?.until) {
        const uIdx = slice.findIndex((s) => s.signature === q.until);
        if (uIdx >= 0) slice = slice.slice(0, uIdx);
      }
      return slice;
    },
    async getTransaction(sig) {
      counts.txCalls++;
      const tx = opts.txByCount?.get(sig);
      if (tx === null) return null;
      // Extract slot from sig name "s<slot>" for the test's convenience
      const slotMatch = sig.match(/^s(\d+)/);
      const slot = slotMatch ? Number(slotMatch[1]) : 0;
      counts.getTxForSlot.push(slot);
      return {
        slot,
        blockTime: 1700000000,
        meta: { logMessages: tx?.logs ?? [], err: tx?.err ?? null },
      };
    },
  };
}

test("recoverGapForMints: empty mints → empty result, no RPC calls", async () => {
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] };
  const rpc = makeMockRpc({ sigsByPda: new Map(), counts });
  const r = await recoverGapForMints(rpc, { fromSlot: 0n, toSlot: 100n }, []);
  assert.equal(r.events.length, 0);
  assert.equal(r.failedMints.length, 0);
  assert.equal(counts.sigCalls, 0);
  assert.equal(counts.txCalls, 0);
});

test("recoverGapForMints: toSlot < fromSlot → empty, no RPC calls", async () => {
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] };
  const rpc = makeMockRpc({ sigsByPda: new Map(), counts });
  const m: AtRiskMint = { mint: "M1", bondingCurvePda: "PDA1" };
  const r = await recoverGapForMints(rpc, { fromSlot: 100n, toSlot: 50n }, [m]);
  assert.equal(r.events.length, 0);
  assert.equal(counts.sigCalls, 0);
});

test("recoverGapForMints: only fetches transactions for sigs within slot window", async () => {
  // sigs are sorted newest→oldest by slot
  const sigs: SigPage = [
    { signature: "s120", slot: 120, blockTime: 1 }, // > toSlot, should skip
    { signature: "s80", slot: 80, blockTime: 1 }, // in window, fetch
    { signature: "s60", slot: 60, blockTime: 1 }, // in window, fetch
    { signature: "s30", slot: 30, blockTime: 1 }, // < fromSlot, STOP
    { signature: "s10", slot: 10, blockTime: 1 }, // would-be skipped (after stop)
  ];
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  const rpc = makeMockRpc({ sigsByPda: new Map([["PDA1", sigs]]), counts });
  const m: AtRiskMint = { mint: "M1", bondingCurvePda: "PDA1" };

  await recoverGapForMints(rpc, { fromSlot: 50n, toSlot: 100n }, [m]);

  // Expect fetch on s80 and s60 only (s120 skipped as too new; s30/s10 cut off by stop)
  assert.deepEqual(counts.getTxForSlot.sort(), [60, 80]);
  assert.equal(counts.txCalls, 2);
});

test("recoverGapForMints: per-mint failure isolation — one bad mint, others succeed", async () => {
  const sigs1: SigPage = [{ signature: "s60", slot: 60, blockTime: 1 }];
  const sigs3: SigPage = [{ signature: "s70", slot: 70, blockTime: 1 }];
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  const rpc = makeMockRpc({
    sigsByPda: new Map([
      ["PDA1", sigs1],
      ["PDA3", sigs3],
    ]),
    throwsOn: new Set(["PDA2"]), // mint 2's getSignatures throws
    counts,
  });
  const mints: AtRiskMint[] = [
    { mint: "M1", bondingCurvePda: "PDA1" },
    { mint: "M2", bondingCurvePda: "PDA2" },
    { mint: "M3", bondingCurvePda: "PDA3" },
  ];
  const r = await recoverGapForMints(rpc, { fromSlot: 50n, toSlot: 100n }, mints);

  assert.deepEqual(r.failedMints, ["M2"]);
  assert.equal(r.perMintRecovered.get("M1"), 0); // empty logMessages → no events, but no failure
  assert.equal(r.perMintRecovered.get("M3"), 0);
  assert.equal(r.perMintRecovered.has("M2"), false);
  // Both successful mints fetched their tx (one each)
  assert.deepEqual(counts.getTxForSlot.sort(), [60, 70]);
});

test("recoverGapForMints: pagination stops on short page (< limit)", async () => {
  // 3 sigs, limit defaults to 100, so we get one page < limit → stop, no second call
  const sigs: SigPage = [
    { signature: "s90", slot: 90, blockTime: 1 },
    { signature: "s80", slot: 80, blockTime: 1 },
    { signature: "s70", slot: 70, blockTime: 1 },
  ];
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  const rpc = makeMockRpc({ sigsByPda: new Map([["PDA1", sigs]]), counts });
  await recoverGapForMints(
    rpc,
    { fromSlot: 50n, toSlot: 100n },
    [{ mint: "M1", bondingCurvePda: "PDA1" }],
  );
  assert.equal(counts.sigCalls, 1, "should only need one getSignaturesForAddress page");
});

test("recoverGapForMints: pagination stops mid-page when slot < fromSlot", async () => {
  // 5 sigs: some are below fromSlot, ensuring we hit the stopped=true path
  const sigs: SigPage = [
    { signature: "s90", slot: 90, blockTime: 1 },
    { signature: "s80", slot: 80, blockTime: 1 },
    { signature: "s30", slot: 30, blockTime: 1 }, // below fromSlot=50, STOP HERE
    { signature: "s20", slot: 20, blockTime: 1 },
    { signature: "s10", slot: 10, blockTime: 1 },
  ];
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  const rpc = makeMockRpc({ sigsByPda: new Map([["PDA1", sigs]]), counts });
  await recoverGapForMints(
    rpc,
    { fromSlot: 50n, toSlot: 100n },
    [{ mint: "M1", bondingCurvePda: "PDA1" }],
  );
  // Only s90 and s80 should be fetched; pagination stopped at s30
  assert.deepEqual(counts.getTxForSlot.sort(), [80, 90]);
  assert.equal(counts.sigCalls, 1); // one page was enough
});

test("recoverGapForMints: honors `untilSig` watermark — stops at known signature", async () => {
  // The mock will return only sigs newer than `until` (drops `until` and older).
  const sigs: SigPage = [
    { signature: "s90", slot: 90, blockTime: 1 },
    { signature: "s80", slot: 80, blockTime: 1 },
    { signature: "S_WATERMARK", slot: 75, blockTime: 1 }, // the watermark — should be dropped
    { signature: "s70", slot: 70, blockTime: 1 }, // older than watermark — also dropped
  ];
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  const rpc = makeMockRpc({ sigsByPda: new Map([["PDA1", sigs]]), counts });
  await recoverGapForMints(
    rpc,
    { fromSlot: 50n, toSlot: 100n, untilSig: "S_WATERMARK" },
    [{ mint: "M1", bondingCurvePda: "PDA1" }],
  );
  // Only s90 and s80 should be fetched; watermark and older were dropped
  assert.deepEqual(counts.getTxForSlot.sort(), [80, 90]);
});

test("recoverGapForMints: respects MAX_SIGNATURES_PER_MINT safety cap", async () => {
  // Build 1000 sigs all in window — way above the 500 cap
  const sigs: SigPage = Array.from({ length: 1000 }, (_, i) => ({
    signature: `s${1000 - i}`,
    slot: 1000 - i,
    blockTime: 1,
  }));
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  const rpc = makeMockRpc({ sigsByPda: new Map([["PDA1", sigs]]), counts });
  await recoverGapForMints(
    rpc,
    { fromSlot: 0n, toSlot: 2000n },
    [{ mint: "M1", bondingCurvePda: "PDA1" }],
  );
  // Should fetch at most 500 transactions
  assert.ok(counts.txCalls <= 500, `expected ≤500 tx fetches, got ${counts.txCalls}`);
  // And page calls should be around 5 (500/100)
  assert.ok(counts.sigCalls <= 6, `expected ≤6 sig page calls, got ${counts.sigCalls}`);
});

/**
 * H06 — failed on-chain transactions must never become trades.
 *
 * The live WebSocket path checks `n.err` and returns. The backfill never did:
 * GapRpc did not even expose `meta.err`, so a reverted transaction's log
 * messages — which pump.fun still emits up to the point of failure — were
 * parsed into real trade events and inserted as if they had happened.
 */
const FIXTURE_MINT = "EecawWtSAu7kanLfFqPRTF5PaaRCMFYRxPrvGfyGpump";
const REAL = JSON.parse(
  readFileSync(join(__dirname, "..", "pump", "__fixtures__", "trade-logs.json"), "utf8"),
) as Record<string, { signature: string; logs: string[] }>;

test("H06: a failed transaction's logs never become events (backfill)", async () => {
  const fixture = REAL.mayhem_buy!;
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  // Same real logs twice: one transaction succeeded, one reverted.
  const rpc = makeMockRpc({
    sigsByPda: new Map([["PDA1", [
      { signature: "s80", slot: 80, blockTime: 1 },
      { signature: "s70", slot: 70, blockTime: 1, err: { InstructionError: [0, "Custom"] } },
    ]]]),
    txByCount: new Map([
      ["s80", { logs: fixture.logs }],
      ["s70", { logs: fixture.logs, err: { InstructionError: [0, "Custom"] } }],
    ]),
    counts,
  });
  const m: AtRiskMint = { mint: FIXTURE_MINT, bondingCurvePda: "PDA1" };
  const r = await recoverGapForMints(rpc, { fromSlot: 0n, toSlot: 100n }, [m]);

  assert.equal(
    r.events.every((e) => e.signature !== "s70"), true,
    "a reverted transaction produced trade events",
  );
  assert.equal(
    counts.getTxForSlot.includes(70), false,
    "an errored signature should be skipped without even fetching the transaction",
  );
});

test("H06: a transaction that only reveals its error on fetch is still rejected", async () => {
  const fixture = REAL.mayhem_buy!;
  const counts = { sigCalls: 0, txCalls: 0, getTxForSlot: [] as number[] };
  // getSignaturesForAddress omitted `err` (older RPC); getTransaction reports it.
  const rpc = makeMockRpc({
    sigsByPda: new Map([["PDA1", [{ signature: "s80", slot: 80, blockTime: 1 }]]]),
    txByCount: new Map([["s80", { logs: fixture.logs, err: { InstructionError: [0, "Custom"] } }]]),
    counts,
  });
  const m: AtRiskMint = { mint: FIXTURE_MINT, bondingCurvePda: "PDA1" };
  const r = await recoverGapForMints(rpc, { fromSlot: 0n, toSlot: 100n }, [m]);
  assert.equal(r.events.length, 0, "meta.err must reject the transaction after fetch");
});

test("H06: a successful transaction with the same logs still recovers", async () => {
  const fixture = REAL.mayhem_buy!;
  const rpc = makeMockRpc({
    sigsByPda: new Map([["PDA1", [{ signature: "s80", slot: 80, blockTime: 1 }]]]),
    txByCount: new Map([["s80", { logs: fixture.logs }]]),
  });
  const m: AtRiskMint = { mint: FIXTURE_MINT, bondingCurvePda: "PDA1" };
  const r = await recoverGapForMints(rpc, { fromSlot: 0n, toSlot: 100n }, [m]);
  assert.ok(r.events.length > 0, "the guard must not reject healthy transactions");
});
