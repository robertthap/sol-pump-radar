import { appendEvent } from "@spr/core";
import { withTx } from "../portfolio";
import type { PaperRuntimeConfig } from "../config";
import type { PoolClient } from "pg";

type Fill = { price: number; tokens: number; cash: number; fee: number; ts: number };

type LockedResearchPosition = {
  mint: string;
  quantity: number;
  notional_sol: number;
  session_id: string;
  current_price: number | null;
  unrealized_pnl_sol: number | null;
  entry_features: Record<string, unknown>;
};

async function lockResearchPosition(client: PoolClient, id: string) {
  return (await client.query<LockedResearchPosition>(
    `SELECT mint,quantity,notional_sol,session_id::text,current_price,
       unrealized_pnl_sol,entry_features
     FROM paper_positions
     WHERE id=$1 AND state='OPEN'
       AND entry_features->>'research_strategy' IS NOT NULL
     FOR UPDATE`,
    [id],
  )).rows[0];
}

async function syncPortfolioEquity(client: PoolClient, balanceDelta = 0, realizedDelta = 0) {
  await client.query(
    `UPDATE paper_portfolio
     SET balance_sol=balance_sol+$1,
         realized_pnl_sol=realized_pnl_sol+$2,
         unrealized_pnl_sol=(
           SELECT COALESCE(sum(unrealized_pnl_sol),0)
           FROM paper_positions WHERE state='OPEN'
         ),
         equity_sol=balance_sol+$1+(
           SELECT COALESCE(sum(notional_sol+COALESCE(unrealized_pnl_sol,0)),0)
           FROM paper_positions WHERE state='OPEN'
         ),
         peak_equity_sol=GREATEST(peak_equity_sol,balance_sol+$1+(
           SELECT COALESCE(sum(notional_sol+COALESCE(unrealized_pnl_sol,0)),0)
           FROM paper_positions WHERE state='OPEN'
         )),
         updated_at=now()
     WHERE id=1`,
    [balanceDelta, realizedDelta],
  );
}

async function finalizeResearchClose(
  client: PoolClient,
  input: { id: string; price: number; proceeds: number; fee: number; reason: string; ts: number },
  position: LockedResearchPosition,
) {
  const pnl = input.proceeds - position.notional_sol;
  await client.query(
    `UPDATE paper_positions SET state='CLOSED',exit_price=$1,current_price=$1,
       realized_pnl_sol=$2,unrealized_pnl_sol=0,closed_at=to_timestamp($3),
       close_reason=$4,
       entry_features=entry_features || '{"research_status":"CLOSED"}'::jsonb
     WHERE id=$5`,
    [input.price, pnl, input.ts, input.reason.slice(0, 32), input.id],
  );
  await client.query(
    `INSERT INTO paper_trade_fills
       (position_id,fill_type,fill_price,quantity,notional_sol,fee_sol,slippage_bps,latency_ms)
     VALUES ($1,'CLOSE',$2,$3,$4,$5,0,0)`,
    [input.id, input.price, position.quantity, input.proceeds, input.fee],
  );
  await syncPortfolioEquity(client, input.proceeds, pnl);
  await client.query(
    `UPDATE paper_portfolio SET wins=wins+$1,losses=losses+$2 WHERE id=1`,
    [pnl > 0 ? 1 : 0, pnl < 0 ? 1 : 0],
  );
  await appendEvent({
    type: "PAPER_TRADE_CLOSED",
    sessionId: BigInt(position.session_id),
    payload: {
      positionId: input.id,
      mint: position.mint,
      realizedPnlSol: pnl,
      reason: input.reason,
      research: true,
    },
    dedupeKey: `research:close:${input.id}`,
  }, client);
  return { ok: true as const, pnl, price: input.price };
}

/** Exact simulated fills share the normal paper ledger and portfolio lock. No live route. */
export async function researchBuy(input: {
  mint: string; key: string; autoSessionId: string; fill: Fill; features: Record<string, unknown>;
  maxConcurrent: number; dailyLossCap: number; addTo?: string;
}, config: PaperRuntimeConfig, transaction: typeof withTx = withTx) {
  const f = input.fill;
  if (![f.price, f.tokens, f.cash].every((n) => Number.isFinite(n) && n > 0) || !(f.fee >= 0)) throw new Error("Invalid research fill");
  return transaction(async (client) => {
    const portfolio = (await client.query<{ session_id: string; balance_sol: number }>("SELECT session_id::text, balance_sol FROM paper_portfolio WHERE id=1 FOR UPDATE")).rows[0];
    if (!portfolio) return { ok: false as const, reason: "Paper portfolio unavailable" };
    // Recheck session and halt inside the worker's transaction before spending paper cash.
    const active = (await client.query("SELECT id FROM auto_sessions WHERE id=$1 AND status='active' AND mode='paper'", [input.autoSessionId])).rows.length > 0;
    if (!active) return { ok: false as const, reason: "Paper bot session is no longer active" };
    const duplicate = (await client.query<{ id: string }>("SELECT id::text FROM paper_positions WHERE correlation_id=$1", [input.key])).rows[0];
    if (!input.addTo && duplicate) return { ok: true as const, id: duplicate.id, duplicate: true };
    const usage = (await client.query<{ count: number; loss: number }>(
      "SELECT count(*) FILTER (WHERE state='OPEN')::int AS count, COALESCE(-sum(realized_pnl_sol) FILTER (WHERE state='CLOSED' AND realized_pnl_sol < 0 AND closed_at::date=current_date),0)::float8 AS loss FROM paper_positions WHERE session_id=$1", [portfolio.session_id])).rows[0];
    if (usage.loss >= Math.min(config.dailyLossLimitSol, input.dailyLossCap)) return { ok: false as const, reason: "Daily paper loss cap reached" };
    if (!input.addTo && usage.count >= Math.min(config.maxOpenPositions, input.maxConcurrent)) return { ok: false as const, reason: "Maximum open positions reached" };
    if (f.cash > portfolio.balance_sol) return { ok: false as const, reason: "Insufficient paper balance" };
    // The session's fixed research stake is explicit user selection. Respect the global per-position cap.
    const maxStake = config.maxPositionSol;
    let id: string;
    if (input.addTo) {
      const old = (await client.query<{ id: string; notional_sol: number; quantity: number; entry_features: Record<string, unknown> }>(
        "SELECT id::text, notional_sol, quantity, entry_features FROM paper_positions WHERE id=$1 AND state='OPEN' AND session_id=$2 FOR UPDATE", [input.addTo, portfolio.session_id])).rows[0];
      if (!old || String(old.entry_features.session_id) !== input.autoSessionId) return { ok: false as const, reason: "Position is no longer open in this session" };
      if (old.entry_features.research_added === true) return { ok: true as const, id: old.id, duplicate: true };
      if (old.notional_sol + f.cash > maxStake + 1e-9) return { ok: false as const, reason: `Position cap ${maxStake} SOL prevents the second tranche` };
      id = old.id;
      await client.query("UPDATE paper_positions SET notional_sol=notional_sol+$1, quantity=quantity+$2, entry_features=entry_features || $3::jsonb WHERE id=$4",
        [f.cash, f.tokens, JSON.stringify({ ...input.features, research_added: true, research_add_ts: f.ts }), id]);
    } else {
      if (f.cash > maxStake + 1e-9) return { ok: false as const, reason: `PAPER_MAX_POSITION_SOL=${maxStake} is below the fixed strategy stake plus transaction fee` };
      id = (await client.query<{ id: string }>(`INSERT INTO paper_positions
        (session_id, correlation_id, mint, side, state, entry_price, current_price, quantity, notional_sol, unrealized_pnl_sol, entry_features, opened_at)
        VALUES ($1,$2,$3,'BUY','OPEN',$4,$4,$5,$6,0,$7::jsonb,to_timestamp($8)) RETURNING id::text`,
      [portfolio.session_id, input.key, input.mint, f.price, f.tokens, f.cash, JSON.stringify(input.features), f.ts])).rows[0].id;
    }
    await client.query("INSERT INTO paper_trade_fills(position_id,fill_type,fill_price,quantity,notional_sol,fee_sol,slippage_bps,latency_ms) VALUES ($1,'OPEN',$2,$3,$4,$5,0,0)", [id, f.price, f.tokens, f.cash, f.fee]);
    await client.query("UPDATE paper_portfolio SET total_trades=total_trades+$1 WHERE id=1", [input.addTo ? 0 : 1]);
    await syncPortfolioEquity(client, -f.cash, 0);
    await appendEvent({ type: "PAPER_TRADE_OPENED", sessionId: BigInt(portfolio.session_id), correlationId: input.key,
      payload: { positionId: id, mint: input.mint, sizeSol: f.cash, fillPrice: f.price, quantity: f.tokens, research: true, add: !!input.addTo, strategy: input.features.research_strategy }, dedupeKey: `research:${input.key}` }, client);
    return { ok: true as const, id, duplicate: false };
  });
}

export async function researchClose(input: { id: string; price: number; proceeds: number; fee: number; reason: string; ts: number }, transaction: typeof withTx = withTx) {
  if (![input.price, input.proceeds, input.fee, input.ts].every(Number.isFinite) || input.price <= 0 || input.proceeds < 0) throw new Error("Invalid research close");
  return transaction(async (client) => {
    await client.query("SELECT id FROM paper_portfolio WHERE id=1 FOR UPDATE");
    const p = await lockResearchPosition(client, input.id);
    if (!p) return { ok: false as const, reason: "Position already closed" };
    return finalizeResearchClose(client, input, p);
  });
}

/** Close a research position only from the strategy's own fresh, net-of-costs mark. */
export async function researchCloseAtMark(
  input: { id: string; reason: string; ts: number; maxMarkAgeMs?: number },
  transaction: typeof withTx = withTx,
) {
  if (!Number.isFinite(input.ts)) throw new Error("Invalid research mark close");
  return transaction(async (client) => {
    await client.query("SELECT id FROM paper_portfolio WHERE id=1 FOR UPDATE");
    const p = await lockResearchPosition(client, input.id);
    if (!p) return { ok: false as const, code: "BAD_STATE", reason: "Position already closed" };
    const mark = p.entry_features.research_mark_pnl;
    const markedAt = Number(p.entry_features.price_at_ms);
    const maxAge = input.maxMarkAgeMs ?? 15_000;
    const nowMs = input.ts * 1000;
    if (
      typeof mark !== "number" || !Number.isFinite(mark) ||
      !(p.current_price != null && Number.isFinite(p.current_price) && p.current_price > 0) ||
      !Number.isFinite(markedAt) || markedAt <= 0 || Math.abs(nowMs - markedAt) > maxAge
    ) {
      return { ok: false as const, code: "STALE_MARK", reason: "No fresh strategy price is available for a truthful manual close" };
    }
    const proceeds = Math.max(0, p.notional_sol + mark);
    const fee = Number(p.entry_features.research_mark_exit_fee);
    return finalizeResearchClose(client, {
      id: input.id,
      price: p.current_price,
      proceeds,
      fee: Number.isFinite(fee) && fee >= 0 ? fee : 0,
      reason: input.reason,
      ts: input.ts,
    }, p);
  });
}

/**
 * End an unpriceable research outcome without manufacturing a win or a loss.
 * Censored rows are terminal and release their cost basis back to available
 * paper cash, but keep realized P&L null and create no synthetic close fill.
 */
export async function researchCensor(
  input: { id: string; reason: string; ts: number },
  transaction: typeof withTx = withTx,
) {
  if (!Number.isFinite(input.ts)) throw new Error("Invalid research censor");
  return transaction(async (client) => {
    await client.query("SELECT id FROM paper_portfolio WHERE id=1 FOR UPDATE");
    const p = await lockResearchPosition(client, input.id);
    if (!p) return { ok: false as const, reason: "Position already terminal" };
    await client.query(
      `UPDATE paper_positions SET state='CLOSED',exit_price=NULL,current_price=NULL,
         realized_pnl_sol=NULL,unrealized_pnl_sol=0,closed_at=to_timestamp($1),
         close_reason='research_censored',
         entry_features=entry_features || $2::jsonb
       WHERE id=$3`,
      [input.ts, JSON.stringify({ research_status: "CENSORED", research_reason: input.reason, research_mark_pnl: null, price_at_ms: 0 }), input.id],
    );
    await syncPortfolioEquity(client, p.notional_sol, 0);
    await appendEvent({
      type: "PAPER_TRADE_CLOSED",
      sessionId: BigInt(p.session_id),
      payload: {
        positionId: input.id,
        mint: p.mint,
        realizedPnlSol: null,
        reason: input.reason,
        research: true,
        censored: true,
      },
      dedupeKey: `research:censor:${input.id}`,
    }, client);
    return { ok: true as const, pnl: null };
  });
}

/** Failed entry/add fees are real paper costs, recorded exactly once across retries. */
export async function researchFailureFee(input: { sessionId: string; key: string; fee: number; positionId?: string }, transaction: typeof withTx = withTx) {
  if (!(input.fee > 0 && Number.isFinite(input.fee))) throw new Error("Invalid failure fee");
  return transaction(async (client) => {
    await client.query("SELECT id FROM paper_portfolio WHERE id=1 FOR UPDATE");
    if (input.positionId) {
      const updated = await client.query(`UPDATE paper_positions SET notional_sol=notional_sol+$1,
        entry_features=entry_features || '{"research_failed_add_fee":true,"research_add_attempted":true}'::jsonb
        WHERE id=$2 AND state='OPEN' AND COALESCE(entry_features->>'research_failed_add_fee','false')='false' RETURNING id`, [input.fee,input.positionId]);
      if (!updated.rows.length) return;
    } else {
      const updated = await client.query(`UPDATE research_episodes SET features=features || jsonb_build_object('failure_fee_sol',$1::float8)
        WHERE session_id=$2 AND episode_key=$3 AND features->>'failure_fee_sol' IS NULL RETURNING episode_key`, [input.fee,input.sessionId,input.key]);
      if (!updated.rows.length) return;
    }
    await client.query(
      `UPDATE paper_portfolio SET balance_sol=balance_sol-$1,
         realized_pnl_sol=realized_pnl_sol-$2,
         equity_sol=equity_sol-$1,updated_at=now() WHERE id=1`,
      [input.fee,input.positionId ? 0 : input.fee],
    );
  });
}
