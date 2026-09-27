import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/log";
import { notify } from "@/lib/notify";
import { rpcCall } from "@/lib/rpc/json-rpc";
import { touchWorker } from "@/lib/workers/heartbeat";
import { accumulateSessionStat } from "@/lib/db/repos/auto-sessions";
import { parseSwapFill, type ParsedSwapTx } from "@/lib/executor/swap-fill";
import {
  bookBuy,
  bookSell,
  decideSettlement,
  finalPnlSol,
  type SignatureStatus,
} from "@/lib/executor/live-settlement-core";

/**
 * Settles live trades against the chain (rules in lib/executor/live-settlement-core).
 *
 * The executor now records a sent buy as `pending` and a sent sell as a
 * `pending_sell` marker on the position; nothing is booked on a signature alone.
 * Each tick this lane checks the pending signatures and, per trade:
 *   confirmed  reads the transaction and books the REAL fill — entry price and
 *              all-in cost for a buy; proceeds, exit price and realized P&L for a
 *              sell (session stats and the notification happen here, once).
 *   failed     on-chain error, or not seen within the blockhash window: a buy is
 *              marked failed (it holds no tokens); an auto-exit sell is reopened so
 *              the exit loop retries it; a manual sell is flagged close_failed; a
 *              failed partial take-profit is cleared so it can fire again.
 *   otherwise  waits.
 */

const log = logger("live-settlement");
const TICK_MS = 2_000;

type PendingSell = {
  sig: string;
  percent: number;
  final: boolean;
  reason: string;
  source: "auto" | "manual";
  sent_at_ms: number;
};

type Row = {
  id: string;
  mint: string;
  status: string;
  session_id: string | null;
  size_sol: number;
  entry_price: number | null;
  tx_signature_open: string | null;
  opened_at: Date | string;
  entry_features: Record<string, unknown> | null;
};

type Job =
  | { kind: "buy"; row: Row; sig: string; sentAtMs: number }
  | { kind: "sell"; row: Row; sig: string; sentAtMs: number; pending: PendingSell };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asPendingSell(v: unknown): PendingSell | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.sig !== "string" || !p.sig) return null;
  return {
    sig: p.sig,
    percent: num(p.percent) ?? 100,
    final: p.final === true,
    reason: typeof p.reason === "string" ? p.reason : "manual",
    source: p.source === "auto" ? "auto" : "manual",
    sent_at_ms: num(p.sent_at_ms) ?? 0,
  };
}

export function startLiveSettlementLane(): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await settleLiveTrades();
      touchWorker("live-settlement", { tickMs: TICK_MS });
    } catch (e) {
      log.warn("settlement tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), TICK_MS);
  return () => {
    stopped = true;
    clearInterval(t);
  };
}

export async function settleLiveTrades(): Promise<void> {
  const res = await getDb().execute(sql`
    SELECT id::text AS id, mint, status, session_id::text AS session_id,
      size_sol::float8 AS size_sol, entry_price::float8 AS entry_price,
      tx_signature_open, opened_at, entry_features
    FROM live_trades
    WHERE dry_run = false
      AND closed_at IS NULL
      AND ((status = 'pending' AND tx_signature_open IS NOT NULL)
           OR entry_features->'pending_sell' IS NOT NULL)
    ORDER BY id ASC
    LIMIT 100
  `);
  const rows = (res as unknown as { rows: Row[] }).rows;
  if (rows.length === 0) return;

  const jobs: Job[] = [];
  for (const row of rows) {
    const ef = row.entry_features ?? {};
    const pending = asPendingSell(ef.pending_sell);
    if (pending) {
      jobs.push({ kind: "sell", row, sig: pending.sig, sentAtMs: pending.sent_at_ms, pending });
    } else if (row.status === "pending" && row.tx_signature_open) {
      const openedAt = row.opened_at instanceof Date ? row.opened_at.getTime() : Date.parse(row.opened_at);
      jobs.push({ kind: "buy", row, sig: row.tx_signature_open, sentAtMs: num(ef.sent_at_ms) ?? openedAt });
    }
  }
  if (jobs.length === 0) return;

  const statuses = await rpcCall<{ value: Array<{ err: unknown; confirmationStatus: string | null } | null> }>(
    "getSignatureStatuses",
    [jobs.map((j) => j.sig), { searchTransactionHistory: true }],
  );
  const now = Date.now();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    const raw = statuses?.value?.[i];
    const status: SignatureStatus | null =
      statuses == null ? null : raw ? { found: true, err: raw.err, confirmationStatus: raw.confirmationStatus } : { found: false };
    const step = decideSettlement(status, job.sentAtMs, now);
    if (step.step === "wait") continue;
    if (step.step === "failed") {
      await applyFailure(job, step.reason);
      continue;
    }
    const tx = await rpcCall<ParsedSwapTx>(
      "getTransaction",
      [job.sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
      8_000,
    );
    if (!tx) continue; // confirmed but not yet served by this endpoint — next tick
    const parsed = parseSwapFill(tx, job.row.mint);
    if (!parsed.ok) {
      await applyFailure(job, `confirmed but no fill for this coin: ${parsed.reason}`);
      continue;
    }
    if (job.kind === "buy") await applyBuy(job, parsed.fill);
    else await applySell(job, parsed.fill);
  }
}

async function applyBuy(job: Extract<Job, { kind: "buy" }>, fill: Parameters<typeof bookBuy>[0]) {
  const b = bookBuy(fill);
  if (!b) {
    await applyFailure(job, `transaction was a ${fill.side}, not a buy`);
    return;
  }
  await getDb().execute(sql`
    UPDATE live_trades
    SET status = 'open',
        entry_price = ${b.entryVSol}::float8,
        fees_sol = ${b.feeSol}::float8,
        entry_features = COALESCE(entry_features, '{}'::jsonb) || jsonb_build_object(
          'entry_v_sol', ${b.entryVSol}::float8,
          'estimated_entry_v_sol', ${job.row.entry_price}::float8,
          'fill_cost_sol', ${b.costSol}::float8,
          'fill_tokens_raw', ${b.tokensRaw.toString()}::text,
          'fill_price_sol', ${fill.priceSol}::float8,
          'fill_fee_sol', ${b.feeSol}::float8,
          'fill_rent_sol', ${fill.tokenAccountRentLamports / 1e9}::float8,
          'confirmed_at_ms', ${Date.now()}::float8)
    WHERE id = ${BigInt(job.row.id)} AND status = 'pending'
  `);
  log.info("live buy confirmed", {
    id: job.row.id, mint: job.row.mint, costSol: b.costSol.toFixed(6), entryVSol: b.entryVSol.toFixed(3),
    estimatedVSol: job.row.entry_price,
  });
}

async function applySell(job: Extract<Job, { kind: "sell" }>, fill: Parameters<typeof bookSell>[0]["fill"]) {
  const ef = job.row.entry_features ?? {};
  const costSol = num(ef.fill_cost_sol) ?? job.row.size_sol;
  const boughtRaw = typeof ef.fill_tokens_raw === "string" ? BigInt(ef.fill_tokens_raw) : null;
  const s = bookSell({ fill, costSol, boughtTokensRaw: boughtRaw, requestedPct: job.pending.percent });
  if (!s) {
    await applyFailure(job, `transaction was a ${fill.side}, not a sell`);
    return;
  }
  const proceedsTotal = (num(ef.proceeds_sol_total) ?? 0) + s.proceedsSol;
  const id = BigInt(job.row.id);

  if (!job.pending.final) {
    await getDb().execute(sql`
      UPDATE live_trades
      SET fees_sol = COALESCE(fees_sol, 0) + ${s.feeSol}::float8,
          entry_features = (COALESCE(entry_features, '{}'::jsonb) - 'pending_sell') || jsonb_build_object(
            'proceeds_sol_total', ${proceedsTotal}::float8,
            'tp1_realized_sol', ${s.realizedSol}::float8,
            'tp1_fill_price_sol', ${fill.priceSol}::float8,
            'tp1_confirmed_at_ms', ${Date.now()}::float8)
      WHERE id = ${id}
    `);
    log.info("live partial sell confirmed", { id: job.row.id, mint: job.row.mint, realized: s.realizedSol.toFixed(6) });
    return;
  }

  const pnl = finalPnlSol({ costSol, proceedsSolTotal: proceedsTotal });
  await getDb().execute(sql`
    UPDATE live_trades
    SET status = 'closed',
        exit_price = ${s.exitVSol}::float8,
        pnl_sol = ${pnl}::float8,
        fees_sol = COALESCE(fees_sol, 0) + ${s.feeSol}::float8,
        exit_reason = ${job.pending.reason},
        tx_signature_close = ${job.sig},
        sell_signature = ${job.sig},
        error_message = NULL,
        closed_at = now(),
        entry_features = (COALESCE(entry_features, '{}'::jsonb) - 'pending_sell') || jsonb_build_object(
          'proceeds_sol_total', ${proceedsTotal}::float8,
          'exit_fill_price_sol', ${fill.priceSol}::float8,
          'settled_at_ms', ${Date.now()}::float8)
    WHERE id = ${id}
  `);
  if (job.row.session_id && job.pending.source === "auto") {
    await accumulateSessionStat(job.row.session_id, "tradesClosed", 1);
    await accumulateSessionStat(job.row.session_id, pnl > 0 ? "wins" : "losses", 1);
    await accumulateSessionStat(job.row.session_id, "realizedPnlSol", pnl);
  }
  log.info("live sell confirmed", { id: job.row.id, mint: job.row.mint, reason: job.pending.reason, pnl: pnl.toFixed(6) });
  await notify({
    kind: pnl >= 0 ? "trade_win" : "trade_loss",
    title: `Live ${job.pending.reason.toUpperCase()} on ${job.row.mint.slice(0, 6)}…`,
    body: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL · confirmed on-chain`,
    mint: job.row.mint,
    pnlSol: pnl,
  }).catch(() => undefined);
}

async function applyFailure(job: Job, reason: string) {
  const id = BigInt(job.row.id);
  const msg = reason.slice(0, 500);
  if (job.kind === "buy") {
    await getDb().execute(sql`
      UPDATE live_trades
      SET status = 'failed', error_message = ${msg}, closed_at = now()
      WHERE id = ${id} AND status = 'pending'
    `);
    log.warn("live buy failed to settle", { id: job.row.id, mint: job.row.mint, reason: msg });
    return;
  }
  if (!job.pending.final) {
    // Clear the take-profit marker so the exit loop can fire it again.
    await getDb().execute(sql`
      UPDATE live_trades
      SET error_message = ${msg},
          entry_features = COALESCE(entry_features, '{}'::jsonb)
            - 'pending_sell' - 'tp1_hit_at' - 'tp1_realized_sol' - 'tp1_pct_of_size' - 'tp1_v_sol' - 'tp1_fraction'
      WHERE id = ${id}
    `);
  } else {
    const nextStatus = job.pending.source === "auto" ? "open" : "close_failed";
    await getDb().execute(sql`
      UPDATE live_trades
      SET status = ${nextStatus}, error_message = ${msg},
          entry_features = COALESCE(entry_features, '{}'::jsonb) - 'pending_sell'
      WHERE id = ${id}
    `);
  }
  log.warn("live sell failed to settle", { id: job.row.id, mint: job.row.mint, final: job.pending.final, reason: msg });
}
