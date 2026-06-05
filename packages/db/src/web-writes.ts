import { getPool } from "./connect";

/**
 * Web command allowlist. domain_events.type wire format:
 *   *_REQUESTED — command accepted (web enqueue)
 *   *_COMPLETED / *_RECORDED — worker durable success
 *   *_REJECTED — worker refused (reason in payload)
 * Postgres tables (paper_positions, live_trades, events) remain primary truth.
 */
export const WebWriteOp = {
  PAPER_RESET_REQUEST: "PAPER_RESET_REQUEST",
  DEMO_RESET_REQUEST: "DEMO_RESET_REQUEST",
  SETTINGS_MODE: "SETTINGS_MODE",
  SETTINGS_SIGNAL_MODE: "SETTINGS_SIGNAL_MODE",
  SETTINGS_LIMITS: "SETTINGS_LIMITS",
  AUTO_SESSION_START: "AUTO_SESSION_START",
  AUTO_SESSION_STOP: "AUTO_SESSION_STOP",
  CIRCUIT_BREAKER: "CIRCUIT_BREAKER",
  LEARNING_RULE_STATUS: "LEARNING_RULE_STATUS",
  PHANTOM_LIVE_RECORD: "PHANTOM_LIVE_RECORD",
  PAPER_TRADE_INTENT: "PAPER_TRADE_INTENT",
  LIVE_TRADE_INTENT: "LIVE_TRADE_INTENT",
  LIVE_SELL_INTENT: "LIVE_SELL_INTENT",
} as const;

export type WebWriteOpType = (typeof WebWriteOp)[keyof typeof WebWriteOp];

const allowed = new Set<string>(Object.values(WebWriteOp));

export async function executeWebMutation<T>(
  op: WebWriteOpType,
  fn: (client: import("pg").PoolClient) => Promise<T>
): Promise<T> {
  if (!allowed.has(op)) {
    throw new Error(`executeWebMutation: unknown op ${op}`);
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
