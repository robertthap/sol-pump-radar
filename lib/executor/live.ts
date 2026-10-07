import "server-only";
import bs58 from "bs58";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import { fetchLivePrice } from "@/lib/pricing/live-price";
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
import { assertMayBroadcast } from "@/lib/runtime/broadcast-guard";
import { dailyLossSol, riskDayWindow } from "@/lib/risk/risk-day";

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

  // M02 — one risk day, Australia/Sydney, shared with the paper engine.
  // `closed_at::date = now()::date` was the DB server's day, which on a UTC
  // server rolls mid-Sydney-morning and allowed two caps' worth of risk.
  const liveDay = riskDayWindow(new Date());
  const lossRes = await getDb().execute(sql`
    SELECT COALESCE(SUM(pnl_sol), 0)::float8 AS net
    FROM live_trades
    WHERE status = 'closed'
      AND closed_at >= ${liveDay.start.toISOString()}::timestamptz
      AND closed_at <  ${liveDay.end.toISOString()}::timestamptz
  `);
  const todayLoss = dailyLossSol({
    closedPnlSol: [(lossRes as unknown as { rows: Array<{ net: number }> }).rows[0]?.net ?? 0],
    partialPnlSol: [],
    feesWithoutPositionSol: [],
  });
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

/**
 * The ONLY place a signed transaction reaches the network. Exported so the
 * central guard can be proven to fire HERE, at the choke point, rather than
 * only in isolation — a guard that is merely unit-tested does not show that it
 * is actually installed.
 */
export async function rpcSendBase64(rpcUrl: string, base64: string): Promise<string> {
  // THE central guard. Every other LIVE check in this codebase lives in a
  // caller, which protects the paths someone remembered to gate; this sits at
  // the choke point itself, so a new call path cannot reach the network by
  // forgetting one. Fails closed, and throws LiveBroadcastBlocked rather than
  // anything a catch would mistake for RPC trouble.
  const e = env();
  assertMayBroadcast({
    runtimeProfile: e.RUNTIME_PROFILE,
    liveExecution: e.LIVE_EXECUTION,
    liveDryRun: e.LIVE_DRY_RUN,
    liveConfirm: e.LIVE_CONFIRM,
  });
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

type TradeRouting =
  | { route: "jupiter"; estimateVSol: number }
  | { route: "pumpportal"; pool: "pump" | "auto"; estimateVSol: number | null }
  | { route: "blocked"; reason: string };

/**
 * Route by the coin's on-chain phase (lib/pricing/live-price.ts), not the `tokens`
 * table — which flagged 0 of the 86 coins traded as graduated while 99.8% of their
 * position marks were graduated, so every live order would have been sent to the
 * bonding curve. Graduated → Jupiter. On the curve → PumpPortal pool "pump".
 * Unknown: a buy is refused (there is no price to record it against); a sell still
 * goes out through PumpPortal pool "auto", which picks the venue, so an exit is
 * never blocked by a failed price read.
 */
async function routeFor(mint: string, side: "buy" | "sell"): Promise<TradeRouting> {
  const live = await fetchLivePrice(mint);
  if (live.phase === "graduated") return { route: "jupiter", estimateVSol: live.vSol };
  if (live.phase === "curve") return { route: "pumpportal", pool: "pump", estimateVSol: live.vSol };
  if (side === "sell") return { route: "pumpportal", pool: "auto", estimateVSol: null };
  return { route: "blocked", reason: `no on-chain price: ${live.reason}` };
}

type PendingSellMarker = {
  sig: string;
  percent: number;
  final: boolean;
  reason: string;
  source: "auto" | "manual";
};

/**
 * Record a sent (unconfirmed) sell on its position. lib/workers/live-settlement.ts
 * books it from the confirmed transaction, or undoes the marker if it never lands.
 */
async function markPendingSell(id: bigint, p: PendingSellMarker): Promise<void> {
  await getDb().execute(sql`
    UPDATE live_trades
    SET status = CASE WHEN ${p.final}::boolean THEN 'pending_close' ELSE status END,
        entry_features = COALESCE(entry_features, '{}'::jsonb) || jsonb_build_object(
          'pending_sell', jsonb_build_object(
            'sig', ${p.sig}::text,
            'percent', ${p.percent}::float8,
            'final', ${p.final}::boolean,
            'reason', ${p.reason}::text,
            'source', ${p.source}::text,
            'sent_at_ms', ${Date.now()}::float8))
    WHERE id = ${id}
  `);
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
    /** "pump" = bonding curve; "auto" = PumpPortal picks the venue (documented option). */
    pool: "pump" | "auto";
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
    pool: opts.pool,
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

/**
 * Pre-fill entry estimate on the same on-chain basis live exits are priced on (the
 * old version read the ingested curve price, frozen for graduated coins). Replaced
 * by the real fill price once lib/workers/live-settlement.ts confirms the buy.
 */
async function estimateEntryVSol(mint: string, hint?: number | null): Promise<number | null> {
  const live = await fetchLivePrice(mint);
  if (live.phase !== "unknown") return live.vSol;
  return hint != null && Number.isFinite(hint) && hint > 0 ? hint : null;
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
  // assertLiveExecutionAllowed() passes while LIVE_DRY_RUN=on, and the worker
  // executor honours that flag by not submitting. This browser-signed path had
  // no such guard: it would hand Phantom a genuine, signable mainnet tx while
  // the operator believed the system was in dry run. Refuse to build one.
  if (e.LIVE_DRY_RUN === "on") {
    return { ok: false, reason: "live_dry_run — refusing to build a signable transaction" };
  }
  const lamports = BigInt(Math.round(opts.sizeSol * 1_000_000_000));
  const routing = await routeFor(opts.mint, "buy");
  if (routing.route === "blocked") return { ok: false, reason: routing.reason };
  const route: LiveTradeRoute = routing.route;
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);

  try {
    if (routing.route === "jupiter") {
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
      pool: routing.pool,
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
  const routing = await routeFor(opts.mint, "sell");
  if (routing.route === "blocked") return { ok: false, reason: routing.reason };
  const route: LiveTradeRoute = routing.route;
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);

  try {
    if (routing.route === "jupiter") {
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
      pool: routing.pool,
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
  const entryVSol = await estimateEntryVSol(opts.mint, opts.entryVSol);
  // Pending until live-settlement confirms the signature and books the real fill.
  const id = await openLivePosition({
    mint: opts.mint,
    sizeSol: opts.sizeSol,
    entryPrice: entryVSol,
    status: "pending",
    dryRun: false,
    route: opts.route,
    txSignatureOpen: opts.signature,
    modulesAtEntry: null,
    entryFeatures: withEntryFeatures(
      { source: opts.source ?? "phantom-buy", wallet: opts.publicKey, sent_at_ms: Date.now() },
      entryVSol,
    ),
    slippageBps: e.LIVE_SLIPPAGE_BPS,
  });
  log.info("phantom buy recorded (pending confirmation)", {
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
  if (openId) {
    // Booked (with real proceeds and P&L) once live-settlement confirms it.
    await markPendingSell(openId, {
      sig: opts.signature,
      percent,
      final: percent === 100,
      reason: "manual_phantom",
      source: "manual",
    });
  }
  log.info("phantom sell recorded (pending confirmation)", {
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
  const routing = await routeFor(opts.mint, "buy");
  if (routing.route === "blocked") {
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      status: "failed",
      dryRun: e.LIVE_DRY_RUN === "on",
      route: "blocked",
      errorMessage: routing.reason,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: { ...(opts.entryFeatures ?? {}), guard: routing.reason },
    });
    log.warn("live buy blocked", { mint: opts.mint, reason: routing.reason });
    return {
      ok: false,
      dryRun: e.LIVE_DRY_RUN === "on",
      signature: null,
      simulatedSignature: null,
      route: "blocked",
      tradeId: id,
      error: routing.reason,
      reason: routing.reason,
    };
  }
  const route: LiveTradeRoute = routing.route;
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);
  // Estimate on the on-chain basis; the confirmed fill replaces it.
  const entryVSol = routing.estimateVSol ?? (await estimateEntryVSol(opts.mint, opts.entryVSol));

  let txBytes: Uint8Array;
  try {
    if (routing.route === "jupiter") {
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
        pool: routing.pool,
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
    // A signature is not a fill. The position stays `pending` (no exit logic, no
    // P&L) until lib/workers/live-settlement.ts confirms it on-chain and books the
    // real price and cost — or marks it failed if it never lands.
    const id = await openLivePosition({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      entryPrice: entryVSol,
      status: "pending",
      dryRun: false,
      route,
      txSignatureOpen: sig,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: {
        ...withEntryFeatures(opts.entryFeatures, entryVSol),
        decision_v_sol: opts.entryVSol ?? null,
        sent_at_ms: Date.now(),
      },
      slippageBps,
    });
    log.info("live buy SENT (pending confirmation)", {
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
  /** The live_trades row this sell belongs to (defaults to the open row for the mint). */
  positionId?: bigint | null;
  /** Exit reason booked when the sell settles (e.g. "sl", "tp1"). Default "manual". */
  reason?: string;
  /** "auto" = exit loop (a failed send/settlement reopens the position for retry). */
  source?: "auto" | "manual";
};

export async function executeLiveSell(opts: ExecuteSellOpts): Promise<LiveTradeResult> {
  const e = env();
  const percent = Math.max(1, Math.min(100, Math.round(opts.percent)));
  const dryRun = e.LIVE_DRY_RUN === "on";
  const source = opts.source ?? "manual";

  // The position, and whether a sell for it is already awaiting confirmation (a
  // second one would try to sell tokens the first may already have sold).
  const positionRows =
    opts.positionId != null
      ? (
          (await getDb().execute(sql`
            SELECT id, entry_features FROM live_trades WHERE id = ${opts.positionId} AND closed_at IS NULL
          `)) as unknown as { rows: Array<{ id: string | bigint; entry_features: Record<string, unknown> | null }> }
        ).rows.map((r) => ({ id: BigInt(r.id), entryFeatures: r.entry_features }))
      : (await fetchOpenLiveByMint(opts.mint)).map((r) => ({
          id: r.id,
          entryFeatures: r.entryFeatures as Record<string, unknown> | null,
        }));
  const openId = positionRows[0]?.id ?? null;
  if (positionRows[0]?.entryFeatures?.pending_sell) {
    return {
      ok: false,
      dryRun,
      signature: null,
      simulatedSignature: null,
      route: "blocked",
      tradeId: openId,
      error: "sell_already_pending",
    };
  }
  const recordSellFailure = async (msg: string) => {
    // A manual sell that could not be sent needs the operator; an auto exit stays
    // open so the exit loop tries again on its next tick.
    if (openId && source === "manual") await markLivePositionCloseFailed(openId, msg);
  };

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

  const routing = await routeFor(opts.mint, "sell");
  // routeFor never blocks a sell; the check keeps the type narrow.
  if (routing.route === "blocked") {
    await recordSellFailure(routing.reason);
    return { ok: false, dryRun, signature: null, simulatedSignature: null, route: "blocked", tradeId: openId, error: routing.reason };
  }
  const route: LiveTradeRoute = routing.route;
  const slippageBps = e.LIVE_SLIPPAGE_BPS;
  const priorityFeeLamports = Math.round(e.LIVE_PRIORITY_FEE_SOL * 1_000_000_000);

  let txBytes: Uint8Array;
  try {
    if (routing.route === "jupiter") {
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
        pool: routing.pool,
      });
      txBytes = r.txBytes;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("live sell build failed", { mint: opts.mint, err: msg, source });
    await recordSellFailure(msg);
    return {
      ok: false,
      dryRun,
      signature: null,
      simulatedSignature: null,
      route,
      tradeId: openId,
      error: msg,
    };
  }

  const signed = signTx(txBytes, opts.keypair);

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
    // Not closed here: live-settlement books the confirmed proceeds and P&L, or
    // undoes this marker if the transaction never lands.
    if (openId) {
      await markPendingSell(openId, {
        sig,
        percent,
        final: percent === 100,
        reason: opts.reason ?? "manual",
        source,
      });
    }
    log.info("live sell SENT (pending confirmation)", { mint: opts.mint, route, sig: sig.slice(0, 12) + "…", percent, source });
    return { ok: true, dryRun: false, signature: sig, simulatedSignature: null, route, tradeId: openId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("live sell send failed", { mint: opts.mint, route, err: msg, source });
    await recordSellFailure(msg);
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
