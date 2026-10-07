import { sql } from "drizzle-orm";
import { appendEvent } from "@spr/core";
import { getRuntimeDb } from "@spr/db";
import { withTx, loadPortfolio, loadOpenPositions } from "../portfolio";
import { applySlippage } from "../slippage";
import { curveValueRatio, curveRealizedPnlSol, curveUnrealizedPnlSol } from "../pnl";
import { checkRisk } from "../risk";
import { assertTransition } from "../state-machine";
import type { PaperRuntimeConfig } from "../config";
import type { PriceResolver, PriceQuote } from "../pricing";

export type OpenIntent = {
  mint: string;
  symbol?: string | null;
  sizeSol: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  correlationId?: string;
  meta?: Record<string, unknown>;
  /** Snapshot of features (signal state, scores) at entry — persisted. */
  entryFeatures?: Record<string, unknown> | null;
  /** Snapshot of strategy modules contributing to this entry. */
  modulesAtEntry?: Record<string, number> | null;
  /** Decision id for cross-referencing with auto-trader history. */
  decisionId?: bigint | null;
};

export type CloseIntent = {
  positionId: bigint;
  reason: string;
  correlationId?: string;
  /**
   * When set (>0), bypass the live price resolver and close at this exact price.
   * Used to force-close stale positions whose mint no longer has a live feed
   * (dead/rugged) so they cannot hold a concurrency slot forever.
   */
  exitPriceOverride?: number;
};

export type PartialCloseIntent = {
  positionId: bigint;
  fraction: number;     // 0 < fraction < 1
  reason: string;       // e.g. "tp1"
  correlationId?: string;
  /** Bypass the live price resolver and fill at this price (see CloseIntent). */
  exitPriceOverride?: number;
};

export type ResetIntent = {
  reason: string;
  startSol: number;
  correlationId?: string;
};

export type ExecutionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: string; reason: string };

async function quoteOrFail(
  resolver: PriceResolver,
  mint: string,
): Promise<PriceQuote | { error: string }> {
  try {
    const q = await resolver(mint);
    if (!q || !Number.isFinite(q.price) || q.price <= 0) {
      return { error: "no live price" };
    }
    return q;
  } catch (e) {
    return { error: `price error: ${String(e)}` };
  }
}

function applyFee(notionalSol: number, feeBps: number, enabled: boolean): number {
  if (!enabled) return 0;
  return (notionalSol * feeBps) / 10_000;
}

async function maybeLatency(config: PaperRuntimeConfig): Promise<number> {
  if (!config.enableLatency) return 0;
  const lo = config.latencyMinMs;
  const hi = Math.max(config.latencyMaxMs, lo);
  const ms = Math.floor(lo + Math.random() * (hi - lo));
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

export async function todayRealizedLossSol(sessionId: bigint): Promise<number> {
  const db = getRuntimeDb();
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(realized_pnl_sol), 0)::float8 AS loss
    FROM paper_positions
    WHERE session_id = ${sessionId.toString()}::bigint
      AND state = 'CLOSED'
      AND closed_at::date = now()::date
      AND realized_pnl_sol < 0
  `);
  const row = (res as unknown as { rows: Array<{ loss: number }> }).rows[0];
  return Math.abs(row?.loss ?? 0);
}

export async function openPosition(
  intent: OpenIntent,
  config: PaperRuntimeConfig,
  resolvePrice: PriceResolver,
): Promise<ExecutionResult<{ positionId: bigint; fillPrice: number; slippageBps: number; latencyMs: number; feeSol: number }>> {
  const portfolio = await loadPortfolio();
  if (!portfolio) return { ok: false, code: "NO_PORTFOLIO", reason: "paper_portfolio missing" };

  const open = await loadOpenPositions(portfolio.sessionId);
  const todayLoss = await todayRealizedLossSol(portfolio.sessionId);

  const risk = checkRisk({
    notionalSol: intent.sizeSol,
    portfolio: {
      balanceSol: portfolio.balanceSol,
      realizedPnlSol: portfolio.realizedPnlSol,
      openPositions: open.length,
    },
    todayLossSol: todayLoss,
    config,
  });
  if (!risk.ok) return { ok: false, code: risk.code, reason: risk.reason };

  const quote = await quoteOrFail(resolvePrice, intent.mint);
  if ("error" in quote) return { ok: false, code: "NO_PRICE", reason: quote.error };

  const latencyMs = await maybeLatency(config);

  const slip = config.enableSlippage
    ? applySlippage({
        side: "BUY",
        quotePrice: quote.price,
        notionalSol: intent.sizeSol,
        referenceVSol: quote.referenceVSol,
        baseBps: config.baseSlippageBps,
      })
    : { fillPrice: quote.price, slippageBps: 0 };

  const feeSol = applyFee(intent.sizeSol, config.feeBps, config.enableFees);
  const quantity = (intent.sizeSol - feeSol) / slip.fillPrice;
  const cashOut = intent.sizeSol;
  const tp = intent.takeProfitPct != null ? slip.fillPrice * (1 + intent.takeProfitPct) : null;
  const sl = intent.stopLossPct != null ? slip.fillPrice * (1 - intent.stopLossPct) : null;

  return withTx(async (client) => {
    const reread = await client.query<{ balance_sol: number; session_id: string }>(
      "SELECT balance_sol, session_id::text AS session_id FROM paper_portfolio WHERE id = 1 FOR UPDATE",
    );
    const row = reread.rows[0];
    if (!row) return { ok: false as const, code: "NO_PORTFOLIO", reason: "missing" };
    if (row.balance_sol < cashOut) {
      return { ok: false as const, code: "INSUFFICIENT_BALANCE", reason: "race-loss" };
    }

    const sessionId = row.session_id;
    const ins = await client.query<{ id: string }>(
      `INSERT INTO paper_positions
        (session_id, correlation_id, mint, symbol, side, state,
         entry_price, current_price, quantity, notional_sol,
         stop_loss, take_profit, unrealized_pnl_sol,
         entry_features, modules_at_entry, decision_id)
       VALUES ($1, $2, $3, $4, 'BUY', 'OPEN', $5, $5, $6, $7, $8, $9, 0,
         $10::jsonb, $11::jsonb, $12)
       RETURNING id::text AS id`,
      [
        sessionId,
        intent.correlationId ?? null,
        intent.mint,
        intent.symbol ?? quote.symbol ?? null,
        slip.fillPrice,
        quantity,
        intent.sizeSol,
        sl,
        tp,
        intent.entryFeatures ? JSON.stringify(intent.entryFeatures) : null,
        intent.modulesAtEntry ? JSON.stringify(intent.modulesAtEntry) : null,
        intent.decisionId ? intent.decisionId.toString() : null,
      ],
    );
    const positionId = BigInt(ins.rows[0]!.id);

    assertTransition("INTENT", "OPEN");

    await client.query(
      `INSERT INTO paper_trade_fills
        (position_id, fill_type, fill_price, quantity, notional_sol, slippage_bps, fee_sol, latency_ms)
       VALUES ($1, 'OPEN', $2, $3, $4, $5, $6, $7)`,
      [positionId.toString(), slip.fillPrice, quantity, intent.sizeSol, slip.slippageBps, feeSol, latencyMs],
    );

    await client.query(
      `UPDATE paper_portfolio
       SET balance_sol = balance_sol - $1,
           equity_sol = balance_sol - $1 + unrealized_pnl_sol,
           total_trades = total_trades + 1,
           updated_at = now()
       WHERE id = 1`,
      [cashOut],
    );

    await appendEvent(
      {
        type: "PAPER_TRADE_OPENED",
        payload: {
          positionId: positionId.toString(),
          mint: intent.mint,
          symbol: intent.symbol ?? quote.symbol ?? null,
          sizeSol: intent.sizeSol,
          fillPrice: slip.fillPrice,
          quantity,
          slippageBps: slip.slippageBps,
          feeSol,
          latencyMs,
          takeProfit: tp,
          stopLoss: sl,
          meta: intent.meta ?? null,
        },
        correlationId: intent.correlationId,
        sessionId: BigInt(sessionId),
        dedupeKey: intent.correlationId ? `paper:open:${intent.correlationId}` : undefined,
      },
      client,
    );

    return {
      ok: true as const,
      data: {
        positionId,
        fillPrice: slip.fillPrice,
        slippageBps: slip.slippageBps,
        latencyMs,
        feeSol,
      },
    };
  });
}

/**
 * Cap on the return an exit-price OVERRIDE may imply. Overrides are force-close
 * bookkeeping (orphan sweep, stale timeout), not live fills; a genuine >10x that
 * the exit logic never acted on is not credible, so anything past this is a
 * basis error. See lib/paper/close-price.ts for the full incident.
 */
const MAX_OVERRIDE_ABS_PCT = 10;

export async function closePosition(
  intent: CloseIntent,
  config: PaperRuntimeConfig,
  resolvePrice: PriceResolver,
): Promise<ExecutionResult<{ exitPrice: number; realizedPnlSol: number; pctOfSize: number; reason: string }>> {
  const db = getRuntimeDb();
  const before = await db.execute(sql`
    SELECT id::text AS id, mint, state, entry_price::float8 AS entry_price,
      quantity::float8 AS quantity, notional_sol::float8 AS notional_sol,
      entry_features,
      session_id::text AS session_id
    FROM paper_positions
    WHERE id = ${intent.positionId.toString()}::bigint
  `);
  const row = (before as unknown as {
    rows: Array<{
      id: string; mint: string; state: string; entry_price: number; quantity: number;
      notional_sol: number; session_id: string;
      entry_features: Record<string, unknown> | null;
    }>;
  }).rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", reason: `position ${intent.positionId} missing` };
  if (row.entry_features?.research_strategy) return { ok: false, code: "STRATEGY_MANAGED", reason: "This research position uses its frozen strategy exit; generic price-proxy closes are disabled." };
  if (row.state !== "OPEN") {
    return { ok: false, code: "BAD_STATE", reason: `cannot close from ${row.state}` };
  }

  const override = intent.exitPriceOverride;
  const useOverride = override != null && Number.isFinite(override) && override > 0;
  // Last line of defence against a price-basis mismatch. Position value scales as
  // vSol SQUARED, so an override on the wrong basis books a squared error: a mark
  // 10x off the entry becomes +11,000%. That really happened (+26.7 and +68.6 SOL
  // booked on 0.24/0.08 SOL positions) because a force-close passed through a
  // mark-to-market price written on the mcap basis. Callers are expected to have
  // reconciled the basis (lib/paper/close-price.ts); this refuses the rest rather
  // than writing fiction into the ledger.
  if (useOverride) {
    const impliedPct = (override / row.entry_price) ** 2 - 1;
    if (!Number.isFinite(impliedPct) || Math.abs(impliedPct) > MAX_OVERRIDE_ABS_PCT) {
      return {
        ok: false,
        code: "BAD_PRICE",
        reason:
          `exit override ${override} vs entry ${row.entry_price} implies ` +
          `${(impliedPct * 100).toFixed(0)}% — refusing (likely a price-basis mismatch)`,
      };
    }
  }
  let quote: PriceQuote;
  if (useOverride) {
    quote = { mint: row.mint, price: override, referenceVSol: override };
  } else {
    const q = await quoteOrFail(resolvePrice, row.mint);
    if ("error" in q) return { ok: false, code: "NO_PRICE", reason: q.error };
    quote = q;
  }

  const latencyMs = useOverride ? 0 : await maybeLatency(config);
  // Force-close (override) fills at the given price with no synthetic slippage —
  // it represents a last-known mark, not a live execution.
  const slip = !useOverride && config.enableSlippage
    ? applySlippage({
        side: "SELL",
        quotePrice: quote.price,
        notionalSol: row.notional_sol,
        referenceVSol: quote.referenceVSol,
        baseBps: config.baseSlippageBps,
      })
    : { fillPrice: quote.price, slippageBps: 0 };

  // Bonding-curve value: a position's SOL value scales as (vSol_now / vSol_entry)²
  // (token price ∝ vSol²), NOT linearly in vSol. entry_price / fillPrice are the
  // curve vSol proxy and already carry entry/exit slippage, so squaring the ratio
  // also applies slippage on the correct (price) basis. notional_sol is the SOL
  // cost basis, which makes realized PnL exactly equal the net balance change.
  const valueRatio = curveValueRatio(row.entry_price, slip.fillPrice);
  const grossOut = row.notional_sol * valueRatio;
  const exitFee = applyFee(grossOut, config.feeBps, config.enableFees);
  // Priority-fee drag (A2): the entry leg was NOT charged at open, so charge the
  // round trip (entry + exit) here against realized PnL + balance. Paper otherwise
  // ignores this real on-chain cost and reads optimistically high.
  const priorityRoundTripSol = config.enableFees ? config.priorityFeeSol * 2 : 0;
  const cashIn = grossOut - exitFee - priorityRoundTripSol;
  const pnl = cashIn - row.notional_sol;
  const pct = row.notional_sol > 0 ? cashIn / row.notional_sol - 1 : 0;

  return withTx(async (client) => {
    // CLOSING is a transient marker so reconcile knows an in-flight close existed.
    assertTransition("OPEN", "CLOSING");
    assertTransition("CLOSING", "CLOSED");

    // H01: the state read above happens OUTSIDE this transaction, so two closes
    // racing on one position both see 'OPEN' and both arrive here. The WHERE
    // clause stops the second from re-writing the row, but nothing stopped it
    // from crediting the balance again: a 1 SOL position settled twice paid out
    // 1.98 SOL and booked two losses. Claim the row and settle ONLY if this
    // transaction is the one that closed it — same guard partialClosePosition
    // has always had.
    const claimed = await client.query<{ id: string }>(
      `UPDATE paper_positions
       SET state = 'CLOSED',
           exit_price = $1,
           current_price = $1,
           realized_pnl_sol = $2,
           unrealized_pnl_sol = 0,
           closed_at = now(),
           close_reason = $3
       WHERE id = $4 AND state = 'OPEN'
       RETURNING id::text AS id`,
      [slip.fillPrice, pnl, intent.reason.slice(0, 32), intent.positionId.toString()],
    );
    if (claimed.rows.length === 0) {
      return { ok: false as const, code: "RACE_LOST", reason: "concurrent close detected" };
    }

    await client.query(
      `INSERT INTO paper_trade_fills
        (position_id, fill_type, fill_price, quantity, notional_sol, slippage_bps, fee_sol, latency_ms)
       VALUES ($1, 'CLOSE', $2, $3, $4, $5, $6, $7)`,
      [intent.positionId.toString(), slip.fillPrice, row.quantity, grossOut, slip.slippageBps, exitFee + priorityRoundTripSol, latencyMs],
    );

    const win = pnl > 0 ? 1 : 0;
    const loss = pnl < 0 ? 1 : 0;
    await client.query(
      `UPDATE paper_portfolio
       SET balance_sol = balance_sol + $1,
           realized_pnl_sol = realized_pnl_sol + $2,
           equity_sol = balance_sol + $1 + unrealized_pnl_sol - $3,
           peak_equity_sol = GREATEST(peak_equity_sol, balance_sol + $1 + unrealized_pnl_sol - $3),
           wins = wins + $4,
           losses = losses + $5,
           updated_at = now()
       WHERE id = 1`,
      [cashIn, pnl, 0, win, loss],
    );

    await appendEvent(
      {
        type: "PAPER_TRADE_CLOSED",
        payload: {
          positionId: intent.positionId.toString(),
          mint: row.mint,
          exitPrice: slip.fillPrice,
          realizedPnlSol: pnl,
          pctOfSize: pct,
          reason: intent.reason,
          slippageBps: slip.slippageBps,
          feeSol: exitFee,
          latencyMs,
        },
        correlationId: intent.correlationId,
        sessionId: BigInt(row.session_id),
        dedupeKey: intent.correlationId ? `paper:close:${intent.correlationId}` : undefined,
      },
      client,
    );

    return {
      ok: true as const,
      data: { exitPrice: slip.fillPrice, realizedPnlSol: pnl, pctOfSize: pct, reason: intent.reason },
    };
  });
}

/**
 * Partial close (e.g. TP1). Sells a fraction of the position, locks in realized
 * PnL for that fraction, and leaves the remaining quantity open. The position
 * stays in 'OPEN' state until a full close (closePosition) runs.
 *
 * One partial close per position: if tp1_at_ts is already set, this is a no-op
 * with a BAD_STATE result, so callers don't fire it twice.
 */
export async function partialClosePosition(
  intent: PartialCloseIntent,
  config: PaperRuntimeConfig,
  resolvePrice: PriceResolver,
): Promise<ExecutionResult<{ exitPrice: number; realizedPnlSol: number; fraction: number; reason: string }>> {
  if (!(intent.fraction > 0 && intent.fraction < 1)) {
    return { ok: false, code: "BAD_FRACTION", reason: `fraction must be (0,1), got ${intent.fraction}` };
  }
  const db = getRuntimeDb();
  const before = await db.execute(sql`
    SELECT id::text AS id, mint, state,
      entry_price::float8 AS entry_price,
      quantity::float8 AS quantity,
      notional_sol::float8 AS notional_sol,
      session_id::text AS session_id,
      tp1_at_ts
    FROM paper_positions
    WHERE id = ${intent.positionId.toString()}::bigint
  `);
  const row = (before as unknown as {
    rows: Array<{
      id: string; mint: string; state: string; entry_price: number; quantity: number;
      notional_sol: number; session_id: string; tp1_at_ts: Date | null;
    }>;
  }).rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", reason: `position ${intent.positionId} missing` };
  if (row.state !== "OPEN") {
    return { ok: false, code: "BAD_STATE", reason: `cannot partial-close from ${row.state}` };
  }
  if (row.tp1_at_ts != null) {
    return { ok: false, code: "ALREADY_PARTIAL", reason: "partial close already executed" };
  }

  const pOverride = intent.exitPriceOverride;
  const pUseOverride = pOverride != null && Number.isFinite(pOverride) && pOverride > 0;
  let quote: PriceQuote;
  if (pUseOverride) {
    quote = { mint: row.mint, price: pOverride, referenceVSol: pOverride };
  } else {
    const q = await quoteOrFail(resolvePrice, row.mint);
    if ("error" in q) return { ok: false, code: "NO_PRICE", reason: q.error };
    quote = q;
  }

  const latencyMs = pUseOverride ? 0 : await maybeLatency(config);
  const partialQty = row.quantity * intent.fraction;
  const partialNotional = row.notional_sol * intent.fraction;
  const slip = !pUseOverride && config.enableSlippage
    ? applySlippage({
        side: "SELL",
        quotePrice: quote.price,
        notionalSol: partialNotional,
        referenceVSol: quote.referenceVSol,
        baseBps: config.baseSlippageBps,
      })
    : { fillPrice: quote.price, slippageBps: 0 };

  // Curve value of the sold fraction (value ∝ vSol²; see closePosition).
  // partialNotional is the SOL cost basis of the slice being sold.
  const valueRatio = curveValueRatio(row.entry_price, slip.fillPrice);
  const grossOut = partialNotional * valueRatio;
  const exitFee = applyFee(grossOut, config.feeBps, config.enableFees);
  // Priority-fee drag (A2): one on-chain leg for this partial sell. (The entry
  // leg + final-exit leg are charged at the full close, so a position with one
  // partial pays 3 legs total = entry + partial-sell + final-sell.)
  const priorityLegSol = config.enableFees ? config.priorityFeeSol : 0;
  const cashIn = grossOut - exitFee - priorityLegSol;
  const pnl = cashIn - partialNotional;

  return withTx(async (client) => {
    const upd = await client.query<{ id: string }>(
      `UPDATE paper_positions
       SET quantity = quantity - $1,
           notional_sol = notional_sol - $2,
           tp1_fraction = COALESCE(tp1_fraction, 0) + $3,
           tp1_realized_sol = COALESCE(tp1_realized_sol, 0) + $4,
           tp1_at_price = $5,
           tp1_at_ts = now()
       WHERE id = $6 AND state = 'OPEN' AND tp1_at_ts IS NULL
       RETURNING id::text AS id`,
      [
        partialQty,
        partialNotional,
        intent.fraction,
        pnl,
        slip.fillPrice,
        intent.positionId.toString(),
      ],
    );
    if (upd.rows.length === 0) {
      return { ok: false as const, code: "RACE_LOST", reason: "concurrent close detected" };
    }

    await client.query(
      `INSERT INTO paper_trade_fills
        (position_id, fill_type, fill_price, quantity, notional_sol, slippage_bps, fee_sol, latency_ms)
       VALUES ($1, 'PARTIAL', $2, $3, $4, $5, $6, $7)`,
      [intent.positionId.toString(), slip.fillPrice, partialQty, grossOut, slip.slippageBps, exitFee + priorityLegSol, latencyMs],
    );

    await client.query(
      `UPDATE paper_portfolio
       SET balance_sol = balance_sol + $1,
           realized_pnl_sol = realized_pnl_sol + $2,
           equity_sol = balance_sol + $1 + unrealized_pnl_sol,
           peak_equity_sol = GREATEST(peak_equity_sol, balance_sol + $1 + unrealized_pnl_sol),
           updated_at = now()
       WHERE id = 1`,
      [cashIn, pnl],
    );

    await appendEvent(
      {
        type: "PAPER_TRADE_CLOSED",
        payload: {
          partial: true,
          positionId: intent.positionId.toString(),
          mint: row.mint,
          exitPrice: slip.fillPrice,
          realizedPnlSol: pnl,
          fraction: intent.fraction,
          reason: intent.reason,
          slippageBps: slip.slippageBps,
          feeSol: exitFee,
          latencyMs,
        },
        correlationId: intent.correlationId,
        sessionId: BigInt(row.session_id),
        dedupeKey: intent.correlationId ? `paper:partial:${intent.correlationId}` : undefined,
      },
      client,
    );

    return {
      ok: true as const,
      data: { exitPrice: slip.fillPrice, realizedPnlSol: pnl, fraction: intent.fraction, reason: intent.reason },
    };
  });
}

/**
 * Recompute current_price + unrealized_pnl on every open position, and update
 * portfolio aggregate. Bounded by the open-position count (small; no batching needed).
 */
export async function markToMarket(resolvePrice: PriceResolver): Promise<{
  positions: number;
  totalUnrealized: number;
}> {
  // MTM only touches fully-open rows — skip CLOSING / INTENT (exit-in-flight).
  const open = (await loadOpenPositions()).filter((p) => p.state === "OPEN");
  if (open.length === 0) {
    // still recompute equity in case balance changed externally
    return withTx(async (client) => {
      await client.query(
        `UPDATE paper_portfolio
         SET unrealized_pnl_sol = 0,
             equity_sol = balance_sol,
             peak_equity_sol = GREATEST(peak_equity_sol, balance_sol),
             updated_at = now()
         WHERE id = 1`,
      );
      return { positions: 0, totalUnrealized: 0 };
    });
  }

  type Update = { id: bigint; current: number; unrealized: number };
  const updates: Update[] = [];
  for (const p of open) {
    if ((p.entryFeatures as Record<string,unknown> | null)?.research_strategy) {
      const f = p.entryFeatures as Record<string,unknown>;
      updates.push({ id: p.id, current: p.currentPrice ?? p.entryPrice,
        unrealized: typeof f.research_mark_pnl === "number" ? f.research_mark_pnl : 0 });
      continue;
    }
    const q = await resolvePrice(p.mint).catch(() => null);
    if (!q || !Number.isFinite(q.price) || q.price <= 0) continue;
    updates.push({
      id: p.id,
      current: q.price,
      unrealized: curveUnrealizedPnlSol(p.entryPrice, q.price, p.notionalSol),
    });
  }

  const totalUnrealized = updates.reduce((sum, u) => sum + u.unrealized, 0);

  return withTx(async (client) => {
    for (const u of updates) {
      await client.query(
        `UPDATE paper_positions
         SET current_price = $1, unrealized_pnl_sol = $2
         WHERE id = $3 AND state = 'OPEN'`,
        [u.current, u.unrealized, u.id.toString()],
      );
    }
    await client.query(
      `UPDATE paper_portfolio
       SET unrealized_pnl_sol = $1,
           equity_sol = balance_sol + $1 + (SELECT COALESCE(sum(notional_sol),0) FROM paper_positions WHERE state='OPEN'),
           peak_equity_sol = GREATEST(peak_equity_sol, balance_sol + $1 + (SELECT COALESCE(sum(notional_sol),0) FROM paper_positions WHERE state='OPEN')),
           updated_at = now()
       WHERE id = 1`,
      [totalUnrealized],
    );
    return { positions: updates.length, totalUnrealized };
  });
}

/**
 * Transactional reset: archive the current session, close any open positions
 * at last-known price (marked as 'reset'), insert a new session, reset the
 * portfolio row. Historical paper_positions/paper_sessions rows are preserved.
 */
export async function resetPortfolio(
  intent: ResetIntent,
  resolvePrice: PriceResolver,
): Promise<ExecutionResult<{ oldSessionId: bigint; newSessionId: bigint; closedPositions: number }>> {
  const portfolio = await loadPortfolio();
  if (!portfolio) return { ok: false, code: "NO_PORTFOLIO", reason: "paper_portfolio missing" };

  const open = await loadOpenPositions(portfolio.sessionId);
  // Best-effort prices for fair-value close; fall back to entry price (zero realized PnL).
  const exitPrices = new Map<bigint, number>();
  for (const p of open) {
    const q = await resolvePrice(p.mint).catch(() => null);
    exitPrices.set(p.id, q?.price ?? p.currentPrice ?? p.entryPrice);
  }

  return withTx(async (client) => {
    for (const p of open) {
      const exitPrice = exitPrices.get(p.id) ?? p.entryPrice;
      const pnl = curveRealizedPnlSol(p.entryPrice, exitPrice, p.notionalSol, 0);
      await client.query(
        `UPDATE paper_positions
         SET state = 'CLOSED',
             exit_price = $1,
             current_price = $1,
             realized_pnl_sol = $2,
             unrealized_pnl_sol = 0,
             closed_at = now(),
             close_reason = 'reset'
         WHERE id = $3`,
        [exitPrice, pnl, p.id.toString()],
      );
    }

    await client.query(
      `UPDATE paper_sessions
       SET ended_at = now(),
           ending_balance_sol = (SELECT balance_sol FROM paper_portfolio WHERE id = 1),
           reset_reason = $1
       WHERE id = $2`,
      [intent.reason.slice(0, 256), portfolio.sessionId.toString()],
    );

    const sessionRes = await client.query<{ id: string }>(
      `INSERT INTO paper_sessions (starting_balance_sol)
       VALUES ($1) RETURNING id::text AS id`,
      [intent.startSol],
    );
    const newSessionId = BigInt(sessionRes.rows[0]!.id);

    await client.query(
      `UPDATE paper_portfolio
       SET session_id = $1,
           balance_sol = $2,
           equity_sol = $2,
           realized_pnl_sol = 0,
           unrealized_pnl_sol = 0,
           peak_equity_sol = $2,
           total_trades = 0,
           wins = 0,
           losses = 0,
           updated_at = now()
       WHERE id = 1`,
      [newSessionId.toString(), intent.startSol],
    );

    await appendEvent(
      {
        type: "PAPER_RESET_COMPLETED",
        payload: {
          reason: intent.reason,
          oldSessionId: portfolio.sessionId.toString(),
          newSessionId: newSessionId.toString(),
          closedPositions: open.length,
          startSol: intent.startSol,
        },
        correlationId: intent.correlationId,
        sessionId: newSessionId,
        dedupeKey: intent.correlationId ? `paper:reset:${intent.correlationId}` : undefined,
      },
      client,
    );

    return {
      ok: true as const,
      data: {
        oldSessionId: portfolio.sessionId,
        newSessionId,
        closedPositions: open.length,
      },
    };
  });
}
