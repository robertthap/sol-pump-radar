/**
 * Real fill of a confirmed swap transaction (PURE — no IO).
 *
 * The live executor used to record a position the moment `sendTransaction`
 * returned a signature, at the price it had estimated before sending. Nothing
 * checked that the transaction landed, how many tokens arrived, or what it cost.
 * This reads those facts from the confirmed transaction's own balance changes
 * (`getTransaction`, jsonParsed): the fee payer's lamport delta and its token
 * balance delta for the mint.
 *
 *   all-in SOL   what actually left (buy) or reached (sell) the wallet, including
 *                network + priority fee and any token-account rent. This is the
 *                P&L basis.
 *   price        SOL per whole token of the swap itself, with the network fee and
 *                token-account rent taken out, so it is comparable to a pool or
 *                curve price (pool fees and slippage stay in, as they should).
 */

export type ParsedTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

export type ParsedSwapTx = {
  transaction: { message: { accountKeys: Array<{ pubkey: string; signer?: boolean } | string> } };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: ParsedTokenBalance[] | null;
    postTokenBalances?: ParsedTokenBalance[] | null;
  } | null;
};

export type SwapFill = {
  side: "buy" | "sell";
  wallet: string;
  /** Token amount moved, raw units (always positive). */
  tokensRaw: bigint;
  decimals: number;
  /**
   * Buy: SOL that left the wallet. Sell: SOL that reached it (negative when the
   * fee exceeded a dust sale's proceeds). All-in, lamports.
   */
  allInLamports: number;
  feeLamports: number;
  /** Rent paid into (buy) or refunded from (sell) the wallet's token account. */
  tokenAccountRentLamports: number;
  /** SOL per whole token of the swap, excluding network fee and account rent. */
  priceSol: number;
};

export type SwapFillResult = { ok: true; fill: SwapFill } | { ok: false; reason: string };

function keyAt(keys: ParsedSwapTx["transaction"]["message"]["accountKeys"], i: number): string | null {
  const k = keys[i];
  if (k == null) return null;
  return typeof k === "string" ? k : k.pubkey;
}

export function parseSwapFill(tx: ParsedSwapTx, mint: string): SwapFillResult {
  const meta = tx.meta;
  if (!meta) return { ok: false, reason: "transaction has no meta" };
  if (meta.err != null) return { ok: false, reason: `transaction failed on-chain: ${JSON.stringify(meta.err)}` };
  const keys = tx.transaction.message.accountKeys;
  const wallet = keyAt(keys, 0);
  if (!wallet) return { ok: false, reason: "no fee payer" };

  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const ownedByWallet = (b: ParsedTokenBalance) => b.mint === mint && b.owner === wallet;

  // Per token account: pre and post raw amounts for the wallet's accounts of `mint`.
  const accounts = new Map<number, { pre: bigint | null; post: bigint | null; decimals: number }>();
  for (const b of pre.filter(ownedByWallet)) {
    accounts.set(b.accountIndex, { pre: BigInt(b.uiTokenAmount.amount), post: null, decimals: b.uiTokenAmount.decimals });
  }
  for (const b of post.filter(ownedByWallet)) {
    const a = accounts.get(b.accountIndex);
    if (a) a.post = BigInt(b.uiTokenAmount.amount);
    else accounts.set(b.accountIndex, { pre: null, post: BigInt(b.uiTokenAmount.amount), decimals: b.uiTokenAmount.decimals });
  }
  if (accounts.size === 0) return { ok: false, reason: "wallet has no balance change for this mint" };

  let delta = 0n;
  let decimals = 6;
  let rentIn = 0; // lamports the wallet put into a newly created token account
  let rentOut = 0; // lamports refunded when a token account was closed
  for (const [idx, a] of accounts) {
    delta += (a.post ?? 0n) - (a.pre ?? 0n);
    decimals = a.decimals;
    const lamportDelta = (meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0);
    if (a.pre == null && lamportDelta > 0) rentIn += lamportDelta;
    if (a.post == null && lamportDelta < 0) rentOut += -lamportDelta;
  }
  if (delta === 0n) return { ok: false, reason: "token balance unchanged" };

  const solDelta = (meta.postBalances[0] ?? 0) - (meta.preBalances[0] ?? 0);
  const fee = meta.fee ?? 0;
  const side: "buy" | "sell" = delta > 0n ? "buy" : "sell";
  const tokensRaw = delta > 0n ? delta : -delta;
  const tokens = Number(tokensRaw) / 10 ** decimals;

  const allInLamports = side === "buy" ? -solDelta : solDelta;
  const swapLamports = side === "buy" ? -solDelta - fee - rentIn : solDelta + fee - rentOut;
  // A confirmed sell can net negative SOL when the fee exceeds tiny proceeds; it is
  // still a real fill. A buy that did not spend SOL, or a swap with no SOL leg, is not.
  if ((side === "buy" && allInLamports <= 0) || swapLamports <= 0 || tokens <= 0) {
    return { ok: false, reason: `implausible SOL movement for a ${side} (${solDelta} lamports)` };
  }
  const priceSol = swapLamports / 1e9 / tokens;
  if (!Number.isFinite(priceSol) || priceSol <= 0) return { ok: false, reason: "unusable price" };

  return {
    ok: true,
    fill: {
      side,
      wallet,
      tokensRaw,
      decimals,
      allInLamports,
      feeLamports: fee,
      tokenAccountRentLamports: side === "buy" ? rentIn : rentOut,
      priceSol,
    },
  };
}
