/**
 * M03 — check the shared fee model against REAL on-chain transactions.
 *
 * Read-only. Fetches recent confirmed pump.fun / PumpSwap swaps, derives the fee
 * actually charged from the transaction's own balance changes, and compares it
 * with packages/trading/src/fees. It writes nothing and signs nothing.
 *
 * This exists as a script rather than a test because it needs mainnet RPC, which
 * the audit container's network policy refuses (403 on CONNECT). Run it on a
 * machine with RPC access before trusting a paper verdict:
 *
 *   pnpm verify:fee-model
 *   pnpm verify:fee-model -- --limit 50 --rpc https://your-endpoint
 *
 * A mismatch means the constants are wrong, NOT that the model should be
 * retuned to match a backtest. Report the measured value and change the
 * constant deliberately.
 */
import { CURVE_FEE, AMM_FEE, BASE_TX_FEE_SOL } from "@spr/trading";

const LAMPORTS = 1_000_000_000;
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

const RPC = arg("rpc", process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
const LIMIT = Math.max(1, Math.min(200, Number(arg("limit", "25"))));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

type Tx = {
  meta: {
    err: unknown; fee: number;
    preBalances: number[]; postBalances: number[];
    preTokenBalances?: Array<{ owner?: string; mint: string; uiTokenAmount: { uiAmount: number | null } }>;
    postTokenBalances?: Array<{ owner?: string; mint: string; uiTokenAmount: { uiAmount: number | null } }>;
    innerInstructions?: unknown[];
  } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: string; signer: boolean }> } };
};

/**
 * Fee actually charged, as a fraction of the SOL that moved.
 *
 * On a buy the signer's lamports fall by (amount in + network fee + any rent).
 * The protocol and creator fees are the lamports that reached the fee accounts,
 * i.e. everything that left the signer but did not reach the pool. Rather than
 * guess which account is which, measure the TOTAL skim: SOL leaving the signer
 * minus the network fee, against the pool's own lamport gain.
 */
function observedFeeFraction(tx: Tx): { fraction: number; solMoved: number } | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys;
  const signer = keys.findIndex((k) => k.signer);
  if (signer < 0) return null;

  const signerDelta = (meta.preBalances[signer]! - meta.postBalances[signer]!) / LAMPORTS;
  const networkFee = meta.fee / LAMPORTS;
  const spent = signerDelta - networkFee;
  if (!(spent > 0)) return null;

  // The largest lamport GAIN among non-signer accounts is the pool leg.
  let poolGain = 0;
  for (let i = 0; i < keys.length; i++) {
    if (i === signer) continue;
    const gain = (meta.postBalances[i]! - meta.preBalances[i]!) / LAMPORTS;
    if (gain > poolGain) poolGain = gain;
  }
  if (!(poolGain > 0) || poolGain > spent) return null;

  return { fraction: (spent - poolGain) / spent, solMoved: spent };
}

async function sample(program: string, label: string, expectedBps: number) {
  console.log(`\n=== ${label} (${program.slice(0, 8)}…) ===`);
  const sigs = await rpc<Array<{ signature: string; err: unknown }>>(
    "getSignaturesForAddress", [program, { limit: LIMIT }],
  );
  const ok = sigs.filter((s) => !s.err).slice(0, LIMIT);
  console.log(`signatures fetched: ${sigs.length}, without error: ${ok.length}`);

  const fractions: number[] = [];
  let networkFeeSum = 0, networkFeeN = 0, skipped = 0;

  for (const s of ok) {
    let tx: Tx | null = null;
    try {
      tx = await rpc<Tx>("getTransaction", [
        s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
    } catch { skipped++; continue; }
    if (!tx?.meta) { skipped++; continue; }
    networkFeeSum += tx.meta.fee / LAMPORTS; networkFeeN++;
    const obs = observedFeeFraction(tx);
    // Only trades large enough that rent/dust cannot dominate the ratio.
    if (!obs || obs.solMoved < 0.01) { skipped++; continue; }
    if (obs.fraction >= 0 && obs.fraction < 0.1) fractions.push(obs.fraction);
  }

  if (!fractions.length) {
    console.log(`no usable swaps in this sample (skipped ${skipped}) — rerun with a larger --limit`);
    return;
  }
  fractions.sort((a, b) => a - b);
  const median = fractions[Math.floor(fractions.length / 2)]!;
  const bps = median * 10_000;

  console.log(`usable swaps      : ${fractions.length} (skipped ${skipped})`);
  console.log(`observed fee      : ${bps.toFixed(1)} bps (median)`);
  console.log(`model says        : ${expectedBps} bps`);
  console.log(`difference        : ${(bps - expectedBps).toFixed(1)} bps`);
  console.log(
    Math.abs(bps - expectedBps) <= 15
      ? "VERDICT: consistent with the model"
      : "VERDICT: MISMATCH — report the measured value; change the constant deliberately, never to flatter a backtest",
  );
  if (networkFeeN) {
    const avgFee = networkFeeSum / networkFeeN;
    console.log(`network fee/tx    : ${avgFee.toFixed(9)} SOL (model base ${BASE_TX_FEE_SOL}, rest is priority)`);
  }
}

async function main() {
  console.log(`RPC: ${RPC}`);
  console.log("Read-only: this script fetches transactions and writes nothing.");
  await sample(PUMP_PROGRAM, "pump.fun bonding curve", CURVE_FEE.totalBps);
  await sample(PUMPSWAP_PROGRAM, "PumpSwap AMM", AMM_FEE.totalBps);
  console.log(
    "\nNote: the observed fraction is the TOTAL skim (protocol + creator). " +
    "The curve split 0.95/0.30 is not separable this way and remains unverified here.",
  );
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
