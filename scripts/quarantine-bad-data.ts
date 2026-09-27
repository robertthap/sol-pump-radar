/**
 * Quarantine data the 2026-09-13 audit proved wrong. Dry run by default; pass
 * --apply to change anything. Nothing is destroyed: rows are MOVED into
 * *_quarantine tables (with a reason) inside one transaction, so every change can
 * be reversed with an INSERT ... SELECT back.
 *
 *   trade_outcomes (the learner's performance source)
 *     - implied move beyond ±1000% (pnl_pct > 10): the orphan-close basis bug that
 *       booked +26.68 SOL on a ~0.24 SOL position (fixed in f625c59; rows remained)
 *     - pnl_sol and pnl_pct with opposite signs (internally inconsistent)
 *     - duplicate rows for the same trade_id (the later copies)
 *     - stop-outs booked at under 10% of entry within 60 s of a mark that was
 *       above -20% on a coin priced above 100 vSol (the missing-data price-basis bug,
 *       e.g. position 1411: a flat ~$60M coin booked at -101%)
 *   events
 *     - "trades" decoded from another program's TradeEvent (Raydium LaunchLab shares
 *       the discriminator): SOL amount above 1,000 and tokens above total supply
 *   worker_heartbeat
 *     - rows for the chart lanes deleted on 2026-09-06, which the health endpoint
 *       reports as permanently unhealthy workers (only if silent for over a day)
 *   paper_positions
 *     - the phantom stop-outs above are FLAGGED (entry_features.accounting_error),
 *       not altered: their P&L is part of the demo account's balance history.
 *
 * Run: tsx --tsconfig tsconfig.cli.json --import ./scripts/preload-cli.ts scripts/quarantine-bad-data.ts [--apply]
 */
import { bootDb, getPool } from "@/lib/db/client";

const APPLY = process.argv.includes("--apply");

const CHART_LANES = ["chart-aggregator", "chart-dex-quotes", "chart-gecko-refresh", "chart-onchain-quotes", "chart-reconcile"];

const BAD_OUTCOMES_SQL = `
  WITH dup AS (
    SELECT id FROM (
      SELECT id, row_number() OVER (PARTITION BY source, trade_id ORDER BY id) AS rn FROM trade_outcomes
    ) x WHERE rn > 1
  ),
  phantom AS (
    SELECT p.id AS position_id
    FROM paper_positions p
    JOIN LATERAL (
      SELECT pct, ts FROM position_marks pm WHERE pm.position_id = p.id ORDER BY ts DESC LIMIT 1
    ) m ON true
    WHERE p.state = 'CLOSED'
      AND p.close_reason LIKE 'sl%'
      AND p.entry_price > 100
      AND p.exit_price > 0
      AND p.exit_price / p.entry_price < 0.1
      AND m.pct > -0.2
      AND p.closed_at - m.ts < interval '60 seconds'
  )
  SELECT o.id,
    CASE
      WHEN abs((o.extras->>'pnl_pct')::float8) > 10 THEN 'implied move beyond 1000%'
      WHEN o.id IN (SELECT id FROM dup) THEN 'duplicate trade_id'
      WHEN sign((o.extras->>'pnl_sol')::float8) <> sign((o.extras->>'pnl_pct')::float8)
           AND abs((o.extras->>'pnl_sol')::float8) > 0.001 THEN 'pnl_sol and pnl_pct disagree in sign'
      WHEN o.source = 'paper' AND o.trade_id IN (SELECT position_id FROM phantom) THEN 'price-basis phantom stop-out'
    END AS reason
  FROM trade_outcomes o
  WHERE abs((o.extras->>'pnl_pct')::float8) > 10
     OR o.id IN (SELECT id FROM dup)
     OR (sign((o.extras->>'pnl_sol')::float8) <> sign((o.extras->>'pnl_pct')::float8)
         AND abs((o.extras->>'pnl_sol')::float8) > 0.001)
     OR (o.source = 'paper' AND o.trade_id IN (SELECT position_id FROM phantom))
`;

const PHANTOM_POSITIONS_SQL = `
  SELECT p.id
  FROM paper_positions p
  JOIN LATERAL (
    SELECT pct, ts FROM position_marks pm WHERE pm.position_id = p.id ORDER BY ts DESC LIMIT 1
  ) m ON true
  WHERE p.state = 'CLOSED' AND p.close_reason LIKE 'sl%' AND p.entry_price > 100 AND p.exit_price > 0
    AND p.exit_price / p.entry_price < 0.1 AND m.pct > -0.2 AND p.closed_at - m.ts < interval '60 seconds'
`;

const BAD_EVENTS_WHERE = `kind IN ('buy', 'sell') AND sol_amount > 1000 AND token_amount > 1000000000`;

async function main() {
  await bootDb();
  const pool = getPool();
  const client = await pool.connect();
  try {
    const outcomes = (await client.query<{ id: string; reason: string }>(BAD_OUTCOMES_SQL)).rows;
    const byReason = new Map<string, number>();
    for (const r of outcomes) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    const pnlSum = (await client.query<{ s: number | null }>(
      `SELECT sum((extras->>'pnl_sol')::float8) AS s FROM trade_outcomes WHERE id = ANY($1::bigint[])`,
      [outcomes.map((o) => o.id)],
    )).rows[0]?.s ?? 0;
    const phantoms = (await client.query<{ id: string }>(PHANTOM_POSITIONS_SQL)).rows;
    const badEvents = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM events WHERE ${BAD_EVENTS_WHERE}`)).rows[0]?.n ?? 0);
    const staleLanes = (await client.query<{ name: string }>(
      `SELECT name FROM worker_heartbeat WHERE name = ANY($1::text[]) AND last_beat < now() - interval '1 day'`,
      [CHART_LANES],
    )).rows;

    console.log("trade_outcomes to quarantine:", outcomes.length, Object.fromEntries(byReason));
    console.log("  their summed pnl_sol:", Number(pnlSum).toFixed(4), "SOL");
    console.log("paper_positions to flag as phantom stop-outs:", phantoms.map((p) => p.id).join(", ") || "none");
    console.log("events decoded from another program:", badEvents);
    console.log("stale heartbeat rows for deleted lanes:", staleLanes.map((r) => r.name).join(", ") || "none");

    if (!APPLY) {
      console.log("\nDry run — nothing changed. Re-run with --apply.");
      return;
    }

    await client.query("BEGIN");
    await client.query(`CREATE TABLE IF NOT EXISTS trade_outcomes_quarantine (LIKE trade_outcomes INCLUDING DEFAULTS)`);
    await client.query(`ALTER TABLE trade_outcomes_quarantine ADD COLUMN IF NOT EXISTS quarantine_reason text`);
    await client.query(`ALTER TABLE trade_outcomes_quarantine ADD COLUMN IF NOT EXISTS quarantined_at timestamptz DEFAULT now()`);
    for (const o of outcomes) {
      await client.query(
        `INSERT INTO trade_outcomes_quarantine SELECT t.*, $2, now() FROM trade_outcomes t WHERE t.id = $1`,
        [o.id, o.reason],
      );
    }
    await client.query(`DELETE FROM trade_outcomes WHERE id = ANY($1::bigint[])`, [outcomes.map((o) => o.id)]);

    await client.query(`CREATE TABLE IF NOT EXISTS events_quarantine (LIKE events INCLUDING DEFAULTS)`);
    await client.query(`ALTER TABLE events_quarantine ADD COLUMN IF NOT EXISTS quarantine_reason text`);
    await client.query(`ALTER TABLE events_quarantine ADD COLUMN IF NOT EXISTS quarantined_at timestamptz DEFAULT now()`);
    await client.query(
      `INSERT INTO events_quarantine SELECT e.*, 'decoded from another program''s TradeEvent', now() FROM events e WHERE ${BAD_EVENTS_WHERE}`,
    );
    await client.query(`DELETE FROM events WHERE ${BAD_EVENTS_WHERE}`);

    await client.query(
      `UPDATE paper_positions SET entry_features = COALESCE(entry_features, '{}'::jsonb)
         || jsonb_build_object('accounting_error', 'price_basis_mismatch', 'accounting_error_flagged_at', now()::text)
       WHERE id = ANY($1::bigint[])`,
      [phantoms.map((p) => p.id)],
    );

    await client.query(
      `DELETE FROM worker_heartbeat WHERE name = ANY($1::text[]) AND last_beat < now() - interval '1 day'`,
      [CHART_LANES],
    );
    await client.query("COMMIT");
    console.log("\nApplied.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
