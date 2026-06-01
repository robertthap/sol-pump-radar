import "server-only";
import bs58 from "bs58";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { eq, sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import { tokens } from "@/lib/db/schema";
import {
  closeLivePosition,
  fetchDailyLiveSol,
  fetchOpenLiveByMint,
  markLivePositionCloseFailed,
  openLivePosition,
  type LiveTradeRoute,
} from "@/lib/db/repos/live-trades";
import { fetchTokenBalance } from "@/lib/wallet/holdings";
import { getEffectiveTradeLimits } from "@/lib/db/repos/settings";

const log = logger("executor:live");

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type LiveTradeResult = {
  ok: boolean;
  dryRun: boolean;
  signature: string | null;
  simulatedSignature: string | null;
  route: LiveTradeRoute;
  tradeId: bigint | null;
  error?: string;
  reason?: string;
};

type GuardOk = { ok: true };
type GuardFail = { ok: false; reason: string };
async function checkCaps(sizeSol: number): Promise<GuardOk | GuardFail> {
  const { assertLiveExecutionAllowed } = await import("@/lib/runtime/live-guards");
  const gate = await assertLiveExecutionAllowed();
  if (!gate.ok) return { ok: false, reason: gate.reason };

  if (sizeSol <= 0) return { ok: false, reason: "size_must_be_positive" };
  const limits = await getEffectiveTradeLimits();
  const e = env();
  if (sizeSol > limits.liveMaxPerTradeSol) {
    return {
      ok: false,
      reason: `per_trade_cap_exceeded (${sizeSol} > ${limits.liveMaxPerTradeSol})`,
    };
  }
  const today = await fetchDailyLiveSol();
  if (today + sizeSol > limits.liveMaxDailySol) {
    return {
      ok: false,
      reason: `daily_cap_exceeded (${today.toFixed(4)} + ${sizeSol} > ${limits.liveMaxDailySol})`,
    };
  }

  const lossRes = await getDb().execute(sql`
    SELECT COALESCE(SUM(pnl_sol), 0)::float8 AS loss
    FROM live_trades
    WHERE status = 'closed'
      AND closed_at::date = now()::date
      AND pnl_sol < 0
  `);
  const todayLoss = Math.abs(
    (lossRes as unknown as { rows: Array<{ loss: number }> }).rows[0]?.loss ?? 0,
  );
  if (todayLoss >= e.LIVE_MAX_DAILY_LOSS_SOL) {
    return { ok: false, reason: `daily_loss_cap (${todayLoss.toFixed(4)} SOL)` };
  }

  const streakRes = await getDb().execute(sql`
    SELECT pnl_sol::float8 AS pnl
    FROM live_trades
    WHERE status = 'closed' AND pnl_sol IS NOT NULL
    ORDER BY closed_at DESC NULLS LAST
    LIMIT ${e.LIVE_MAX_CONSECUTIVE_LOSSES}
  `);
  const streak = (streakRes as unknown as { rows: Array<{ pnl: number }> }).rows;
  if (
    streak.length >= e.LIVE_MAX_CONSECUTIVE_LOSSES &&
    streak.every((r) => r.pnl <= 0)
  ) {
    return { ok: false, reason: `consecutive_loss_cap (${streak.length})` };
  }

  return { ok: true };
}

async function rpcSendBase64(rpcUrl: string, base64: string): Promise<string> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        base64,
        { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
      ],
    }),
  });
  if (!r.ok) throw new Error(`sendTransaction HTTP ${r.status}`);
  const j = (await r.json()) as
    | { result: string }
    | { error: { code: number; message: string } };
  if ("error" in j) throw new Error(`sendTransaction: ${j.error.message}`);
  return j.result;
}

async function isGraduated(mint: string): Promise<boolean> {
  const rows = await getDb()
    .select({ graduatedAt: tokens.graduatedAt, status: tokens.status })
    .from(tokens)
    .where(eq(tokens.mint, mint))
    .limit(1);
  const t = rows[0];
  if (!t) return false;
  return t.graduatedAt != null || t.status === "graduated" || t.status === "completed";
}

function firstSignatureFromBytes(rawTxBytes: Uint8Array): string {
  // Compact-u16 length-prefixed sigs[64], first 64 bytes after the length byte(s).
  // Versioned tx serialization starts with sig count varint then sigs[].
  // Easier: deserialize then read .signatures[0].
  const tx = VersionedTransaction.deserialize(rawTxBytes);
  const first = tx.signatures[0];
  if (!first) return "";
  return bs58.encode(Buffer.from(first));
}

type PumpPortalResp = ArrayBuffer | string;

async function pumpPortalSign(
  opts: {
    action: "buy" | "sell";
    publicKey: string;
    mint: string;
    amount: string | number;
    denominatedInSol: "true" | "false";
    slippageBps: number;
    priorityFeeSol: number;
  },
): Promise<{ txBytes: Uint8Array }> {
  const body = {
    publicKey: opts.publicKey,
    action: opts.action,
    mint: opts.mint,
    amount: opts.amount,
    denominatedInSol: opts.denominatedInSol,
    slippage: opts.slippageBps / 100,
    priorityFee: opts.priorityFeeSol,
    pool: "pump",
  };
  const r = await fetch(env().PUMPPORTAL_TRADE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`pumpportal ${r.status}: ${txt.slice(0, 200)}`);
  }
  const ab: PumpPortalResp = await r.arrayBuffer();
  const bytes = ab instanceof ArrayBuffer ? new Uint8Array(ab) : new Uint8Array(0);
  if (bytes.byteLength === 0) throw new Error("pumpportal returned empty body");
  return { txBytes: bytes };
}

async function jupiterSwap(opts: {
  publicKey: string;
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
  priorityFeeLamports: number;
}): Promise<{ txBytes: Uint8Array }> {
  const base = env().JUPITER_BASE_URL.replace(/\/$/, "");
  const qs = new URLSearchParams({
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amount: opts.amountLamports.toString(),
    slippageBps: String(opts.slippageBps),
    onlyDirectRoutes: "false",
  });
  const quoteRes = await fetch(`${base}/quote?${qs.toString()}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!quoteRes.ok) {
    const t = await quoteRes.text().catch(() => "");
    throw new Error(`jupiter quote ${quoteRes.status}: ${t.slice(0, 200)}`);
  }
  const quote = (await quoteRes.json()) as unknown;
  const swapRes = await fetch(`${base}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: opts.publicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: opts.priorityFeeLamports,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!swapRes.ok) {
    const t = await swapRes.text().catch(() => "");
    throw new Error(`jupiter swap ${swapRes.status}: ${t.slice(0, 200)}`);
  }
  const swap = (await swapRes.json()) as { swapTransaction?: string };
  if (!swap.swapTransaction) throw new Error("jupiter swap returned no transaction");
  const bytes = new Uint8Array(Buffer.from(swap.swapTransaction, "base64"));
  return { txBytes: bytes };
}

function signTx(rawTxBytes: Uint8Array, kp: Keypair): {
  tx: VersionedTransaction;
  serialized: string;
  signature: string;
} {
  const tx = VersionedTransaction.deserialize(rawTxBytes);
  tx.sign([kp]);
  const serialized = Buffer.from(tx.serialize()).toString("base64");
  const sigBytes = tx.signatures[0];
  if (!sigBytes) throw new Error("tx missing signature after signing");
  return { tx, serialized, signature: bs58.encode(Buffer.from(sigBytes)) };
}

export type ExecuteBuyOpts = {
  mint: string;
  sizeSol: number;
  keypair: Keypair;
  rpcUrl: string;
  /** Bonding-curve v_sol at entry — required for auto-exit TP/SL. */
  entryVSol?: number | null;
  modulesAtEntry?: Record<string, number> | null;
  entryFeatures?: Record<string, unknown> | null;
  decisionId?: bigint | null;
};

async function resolveEntryVSol(mint: string, hint?: number | null): Promise<number | null> {
  if (hint != null && Number.isFinite(hint) && hint > 0) return hint;
  const res = await getDb().execute(sql`
    SELECT v_sol_after::float8 AS v
    FROM events
    WHERE mint = ${mint} AND v_sol_after IS NOT NULL
    ORDER BY ts DESC
    LIMIT 1
  `);
  const v = (res as unknown as { rows: Array<{ v: number | null }> }).rows[0]?.v;
  return v != null && v > 0 ? v : null;
}

function withEntryFeatures(
  base: Record<string, unknown> | null | undefined,
  entryVSol: number | null,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(entryVSol != null ? { entry_v_sol: entryVSol } : {}),
  };
}

/** Build unsigned buy tx for Phantom (client signs via signAndSendTransaction). */
export async function buildUnsignedLiveBuyTx(opts: {
  mint: string;
  sizeSol: number;
  publicKey: string;
}): Promise<
  | { ok: true; txBase64: string; route: LiveTradeRoute }
  | { ok: false; reason: string }
> {
  const cap = await checkCaps(opts.sizeSol);
  if (!cap.ok) return { ok: false, reason: cap.reason };

  const e = env();
  const lamports = BigInt(Math.round(opts.sizeSol * 1_000_000_000));
  const graduated = await isGraduated(opts.mint);
  const route: LiveTradeRoute = graduated ? "jupiter" : "pumpportal";
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);

  try {
    if (route === "jupiter") {
      const r = await jupiterSwap({
        publicKey: opts.publicKey,
        inputMint: WSOL_MINT,
        outputMint: opts.mint,
        amountLamports: lamports,
        slippageBps,
        priorityFeeLamports,
      });
      return { ok: true, txBase64: Buffer.from(r.txBytes).toString("base64"), route };
    }
    const r = await pumpPortalSign({
      action: "buy",
      publicKey: opts.publicKey,
      mint: opts.mint,
      amount: opts.sizeSol,
      denominatedInSol: "true",
      slippageBps,
      priorityFeeSol: e.LIVE_PRIORITY_FEE_SOL,
    });
    return { ok: true, txBase64: Buffer.from(r.txBytes).toString("base64"), route };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Build unsigned sell tx for Phantom (client signs via signAndSendTransaction). */
export async function buildUnsignedLiveSellTx(opts: {
  mint: string;
  percent: number;
  publicKey: string;
  rpcUrl: string;
}): Promise<
  | { ok: true; txBase64: string; route: LiveTradeRoute }
  | { ok: false; reason: string }
> {
  const percent = Math.max(1, Math.min(100, Math.round(opts.percent)));
  const bal = await fetchTokenBalance(opts.publicKey, opts.mint, opts.rpcUrl);
  if (!bal || bal.amount === 0n) return { ok: false, reason: "no_token_balance" };
  const rawAmount = (bal.amount * BigInt(percent)) / 100n;
  if (rawAmount === 0n) return { ok: false, reason: "amount_rounded_to_zero" };

  const e = env();
  const graduated = await isGraduated(opts.mint);
  const route: LiveTradeRoute = graduated ? "jupiter" : "pumpportal";
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);

  try {
    if (route === "jupiter") {
      const r = await jupiterSwap({
        publicKey: opts.publicKey,
        inputMint: opts.mint,
        outputMint: WSOL_MINT,
        amountLamports: rawAmount,
        slippageBps,
        priorityFeeLamports,
      });
      return { ok: true, txBase64: Buffer.from(r.txBytes).toString("base64"), route };
    }
    const uiAmount = (bal.uiAmount * percent) / 100;
    const r = await pumpPortalSign({
      action: "sell",
      publicKey: opts.publicKey,
      mint: opts.mint,
      amount: uiAmount,
      denominatedInSol: "false",
      slippageBps,
      priorityFeeSol: e.LIVE_PRIORITY_FEE_SOL,
    });
    return { ok: true, txBase64: Buffer.from(r.txBytes).toString("base64"), route };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Record a Phantom-signed buy after the client broadcast the tx. */
export async function recordPhantomLiveBuy(opts: {
  mint: string;
  sizeSol: number;
  signature: string;
  route: LiveTradeRoute;
  entryVSol?: number | null;
  publicKey: string;
  source?: string;
}): Promise<{ ok: true; tradeId: bigint } | { ok: false; error: string }> {
  const cap = await checkCaps(opts.sizeSol);
  if (!cap.ok) return { ok: false, error: cap.reason };
  const e = env();
  const entryVSol = await resolveEntryVSol(opts.mint, opts.entryVSol);
  const id = await openLivePosition({
    mint: opts.mint,
    sizeSol: opts.sizeSol,
    entryPrice: entryVSol,
    status: "open",
    dryRun: false,
    route: opts.route,
    txSignatureOpen: opts.signature,
    modulesAtEntry: null,
    entryFeatures: withEntryFeatures(
      { source: opts.source ?? "phantom-buy", wallet: opts.publicKey },
      entryVSol,
    ),
    slippageBps: e.LIVE_SLIPPAGE_BPS,
  });
  log.info("phantom buy recorded", {
    mint: opts.mint,
    sig: opts.signature.slice(0, 12) + "…",
    sizeSol: opts.sizeSol,
  });
  return { ok: true, tradeId: id };
}

/** Record a Phantom-signed sell after the client broadcast the tx. */
export async function recordPhantomLiveSell(opts: {
  mint: string;
  percent: number;
  signature: string;
  route: LiveTradeRoute;
}): Promise<{ ok: true; tradeId: bigint | null } | { ok: false; error: string }> {
  const percent = Math.max(1, Math.min(100, Math.round(opts.percent)));
  const open = await fetchOpenLiveByMint(opts.mint);
  const openId = open[0]?.id ?? null;
  if (openId && percent === 100) {
    await closeLivePosition({
      id: openId,
      status: "closed",
      exitReason: "manual_phantom",
      txSignatureClose: opts.signature,
    });
  }
  log.info("phantom sell recorded", {
    mint: opts.mint,
    sig: opts.signature.slice(0, 12) + "…",
    percent,
  });
  return { ok: true, tradeId: openId };
}

export async function executeLiveBuy(opts: ExecuteBuyOpts): Promise<LiveTradeResult> {
  const e = env();
  const cap = await checkCaps(opts.sizeSol);
  if (!cap.ok) {
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      status: "failed",
      dryRun: e.LIVE_DRY_RUN === "on",
      route: "blocked",
      errorMessage: cap.reason,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: { ...(opts.entryFeatures ?? {}), guard: cap.reason },
    });
    log.warn("live buy blocked", { mint: opts.mint, reason: cap.reason });
    return {
      ok: false,
      dryRun: e.LIVE_DRY_RUN === "on",
      signature: null,
      simulatedSignature: null,
      route: "blocked",
      tradeId: id,
      error: cap.reason,
      reason: cap.reason,
    };
  }

  const lamports = BigInt(Math.round(opts.sizeSol * 1_000_000_000));
  const graduated = await isGraduated(opts.mint);
  const route: LiveTradeRoute = graduated ? "jupiter" : "pumpportal";
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);
  const entryVSol = await resolveEntryVSol(opts.mint, opts.entryVSol);

  let txBytes: Uint8Array;
  try {
    if (route === "jupiter") {
      const r = await jupiterSwap({
        publicKey: opts.keypair.publicKey.toBase58(),
        inputMint: WSOL_MINT,
        outputMint: opts.mint,
        amountLamports: lamports,
        slippageBps,
        priorityFeeLamports,
      });
      txBytes = r.txBytes;
    } else {
      const r = await pumpPortalSign({
        action: "buy",
        publicKey: opts.keypair.publicKey.toBase58(),
        mint: opts.mint,
        amount: opts.sizeSol,
        denominatedInSol: "true",
        slippageBps,
        priorityFeeSol: e.LIVE_PRIORITY_FEE_SOL,
      });
      txBytes = r.txBytes;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      status: "failed",
      dryRun: e.LIVE_DRY_RUN === "on",
      route,
      errorMessage: msg,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: opts.entryFeatures ?? null,
      slippageBps,
    });
    log.error("live buy quote/build failed", { mint: opts.mint, route, err: msg });
    return {
      ok: false,
      dryRun: e.LIVE_DRY_RUN === "on",
      signature: null,
      simulatedSignature: null,
      route,
      tradeId: id,
      error: msg,
    };
  }

  let signed: ReturnType<typeof signTx>;
  try {
    signed = signTx(txBytes, opts.keypair);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      status: "failed",
      dryRun: e.LIVE_DRY_RUN === "on",
      route,
      errorMessage: `sign_failed: ${msg}`,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: opts.entryFeatures ?? null,
      slippageBps,
    });
    return {
      ok: false,
      dryRun: e.LIVE_DRY_RUN === "on",
      signature: null,
      simulatedSignature: null,
      route,
      tradeId: id,
      error: msg,
    };
  }

  const dryRun = e.LIVE_DRY_RUN === "on";
  if (dryRun) {
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      entryPrice: entryVSol,
      status: "open",
      dryRun: true,
      route,
      txSignatureOpen: null,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: {
        ...withEntryFeatures(opts.entryFeatures, entryVSol),
        simulatedSignature: signed.signature,
      },
      slippageBps,
    });
    log.info("live buy DRY_RUN (signed, not sent)", {
      mint: opts.mint,
      route,
      simSig: signed.signature.slice(0, 12) + "…",
      sizeSol: opts.sizeSol,
    });
    return {
      ok: true,
      dryRun: true,
      signature: null,
      simulatedSignature: signed.signature,
      route,
      tradeId: id,
    };
  }

  // Real send path. Never reached during dry-run verification.
  try {
    const sig = await rpcSendBase64(opts.rpcUrl, signed.serialized);
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      entryPrice: entryVSol,
      status: "open",
      dryRun: false,
      route,
      txSignatureOpen: sig,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: withEntryFeatures(opts.entryFeatures, entryVSol),
      slippageBps,
    });
    log.info("live buy SENT", {
      mint: opts.mint,
      route,
      sig: sig.slice(0, 12) + "…",
      sizeSol: opts.sizeSol,
    });
    return { ok: true, dryRun: false, signature: sig, simulatedSignature: null, route, tradeId: id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      status: "failed",
      dryRun: false,
      route,
      errorMessage: `send_failed: ${msg}`,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: opts.entryFeatures ?? null,
      slippageBps,
    });
    log.error("live buy send failed", { mint: opts.mint, route, err: msg });
    void firstSignatureFromBytes;
    return {
      ok: false,
      dryRun: false,
      signature: null,
      simulatedSignature: null,
      route,
      tradeId: id,
      error: msg,
    };
  }
}

export type ExecuteSellOpts = {
  mint: string;
  percent: number; // 1-100
  keypair: Keypair;
  rpcUrl: string;
};

export async function executeLiveSell(opts: ExecuteSellOpts): Promise<LiveTradeResult> {
  const e = env();
  const percent = Math.max(1, Math.min(100, Math.round(opts.percent)));
  const dryRun = e.LIVE_DRY_RUN === "on";

  // Look up the user's balance. We size by raw token amount.
  const bal = await fetchTokenBalance(opts.keypair.publicKey.toBase58(), opts.mint, opts.rpcUrl);
  if (!bal || bal.amount === 0n) {
    return {
      ok: false,
      dryRun,
      signature: null,
      simulatedSignature: null,
      route: "blocked",
      tradeId: null,
      error: "no_token_balance",
    };
  }
  const rawAmount = (bal.amount * BigInt(percent)) / 100n;
  if (rawAmount === 0n) {
    return {
      ok: false,
      dryRun,
      signature: null,
      simulatedSignature: null,
      route: "blocked",
      tradeId: null,
      error: "amount_rounded_to_zero",
    };
  }

  const graduated = await isGraduated(opts.mint);
  const route: LiveTradeRoute = graduated ? "jupiter" : "pumpportal";
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);

  let txBytes: Uint8Array;
  try {
    if (route === "jupiter") {
      const r = await jupiterSwap({
        publicKey: opts.keypair.publicKey.toBase58(),
        inputMint: opts.mint,
        outputMint: WSOL_MINT,
        amountLamports: rawAmount,
        slippageBps,
        priorityFeeLamports,
      });
      txBytes = r.txBytes;
    } else {
      // PumpPortal sell takes a token amount (denominatedInSol='false').
      // We pass the human ui-amount the user holds (scaled by percent).
      const uiAmount = (bal.uiAmount * percent) / 100;
      const r = await pumpPortalSign({
        action: "sell",
        publicKey: opts.keypair.publicKey.toBase58(),
        mint: opts.mint,
        amount: uiAmount,
        denominatedInSol: "false",
        slippageBps,
        priorityFeeSol: e.LIVE_PRIORITY_FEE_SOL,
      });
      txBytes = r.txBytes;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("live sell build failed", { mint: opts.mint, err: msg });
    const open = await fetchOpenLiveByMint(opts.mint);
    const openId = open[0]?.id ?? null;
    if (openId) await markLivePositionCloseFailed(openId, msg);
    return {
      ok: false,
      dryRun,
      signature: null,
      simulatedSignature: null,
      route,
      tradeId: null,
      error: msg,
    };
  }

  const signed = signTx(txBytes, opts.keypair);

  // If we have an open live position for this mint, mark it closed (or partially).
  const open = await fetchOpenLiveByMint(opts.mint);
  const openId = open[0]?.id ?? null;

  if (dryRun) {
    if (openId && percent === 100) {
      await closeLivePosition({
        id: openId,
        status: "closed",
        exitReason: "manual_dry_run",
        txSignatureClose: null,
        errorMessage: `simulated: ${signed.signature}`,
      });
    }
    log.info("live sell DRY_RUN (signed, not sent)", {
      mint: opts.mint,
      route,
      simSig: signed.signature.slice(0, 12) + "…",
      percent,
    });
    return {
      ok: true,
      dryRun: true,
      signature: null,
      simulatedSignature: signed.signature,
      route,
      tradeId: openId,
    };
  }

  try {
    const sig = await rpcSendBase64(opts.rpcUrl, signed.serialized);
    if (openId && percent === 100) {
      await closeLivePosition({
        id: openId,
        status: "closed",
        exitReason: "manual",
        txSignatureClose: sig,
      });
    }
    log.info("live sell SENT", { mint: opts.mint, route, sig: sig.slice(0, 12) + "…", percent });
    return { ok: true, dryRun: false, signature: sig, simulatedSignature: null, route, tradeId: openId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("live sell send failed", { mint: opts.mint, route, err: msg });
    if (openId) await markLivePositionCloseFailed(openId, msg);
    return {
      ok: false,
      dryRun: false,
      signature: null,
      simulatedSignature: null,
      route,
      tradeId: openId,
      error: msg,
    };
  }
}
