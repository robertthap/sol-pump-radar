import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { classifyPoolAccount, type PoolAccountValue } from "./pool-account";
import { PUMP_SWAP_AMM_PROGRAM, WSOL_MINT } from "./program";

const MEME_MINT = bs58.encode(Buffer.alloc(32, 7));
const OTHER_MINT = bs58.encode(Buffer.alloc(32, 9));

function account(baseMint: string, quoteMint: string, owner = PUMP_SWAP_AMM_PROGRAM): PoolAccountValue {
  const data = Buffer.alloc(107);
  Buffer.from(bs58.decode(baseMint)).copy(data, 43);
  Buffer.from(bs58.decode(quoteMint)).copy(data, 75);
  return { owner, data: [data.toString("base64"), "base64"] };
}

test("classifies a WSOL-base PumpSwap pool", () => {
  assert.deepEqual(classifyPoolAccount(account(WSOL_MINT, MEME_MINT)), {
    kind: "resolved",
    info: { memeMint: MEME_MINT, baseIsWsol: true },
  });
});

test("classifies a WSOL-quote PumpSwap pool", () => {
  assert.deepEqual(classifyPoolAccount(account(MEME_MINT, WSOL_MINT)), {
    kind: "resolved",
    info: { memeMint: MEME_MINT, baseIsWsol: false },
  });
});

test("retries missing and not-yet-initialized accounts", () => {
  assert.deepEqual(classifyPoolAccount(null), { kind: "retry" });
  assert.deepEqual(
    classifyPoolAccount({ owner: PUMP_SWAP_AMM_PROGRAM, data: [Buffer.alloc(32).toString("base64"), "base64"] }),
    { kind: "retry" },
  );
});

test("caches definitive negative accounts", () => {
  assert.deepEqual(classifyPoolAccount(account(MEME_MINT, OTHER_MINT)), { kind: "negative" });
  assert.deepEqual(classifyPoolAccount(account(WSOL_MINT, MEME_MINT, OTHER_MINT)), { kind: "negative" });
});
