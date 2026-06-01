import { getRuntimeDb, tradesFsm } from "@spr/db";
import { eq } from "drizzle-orm";
import { assertTransition, type TradeFsmState } from "./trade-state";
import { appendEvent } from "./events";

export type TradeFsmRow = typeof tradesFsm.$inferSelect;

const eventForState: Partial<Record<TradeFsmState, string>> = {
  OPEN: "TRADE_OPENED",
  CLOSED: "TRADE_CLOSED",
  FAILED: "TRADE_FAILED",
};

export async function createTradeIntent(mint: string, meta?: Record<string, unknown>) {
  const db = getRuntimeDb();
  const [row] = await db
    .insert(tradesFsm)
    .values({ mint, state: "INTENT", meta: meta ?? null })
    .returning();
  if (!row) throw new Error("createTradeIntent: insert failed");
  await appendEvent(
    "TRADE_INTENT",
    { mint, tradeId: String(row.id) },
    `trade-intent:${row.id}`
  );
  return row;
}

export async function transitionTrade(id: bigint, to: TradeFsmState) {
  const db = getRuntimeDb();
  const [current] = await db.select().from(tradesFsm).where(eq(tradesFsm.id, id)).limit(1);
  if (!current) throw new Error(`transitionTrade: missing id ${id}`);
  const from = current.state as TradeFsmState;
  assertTransition(from, to);
  const [row] = await db
    .update(tradesFsm)
    .set({ state: to, updatedAt: new Date() })
    .where(eq(tradesFsm.id, id))
    .returning();
  if (!row) throw new Error(`transitionTrade: update failed id ${id}`);
  const ev = eventForState[to];
  if (ev) {
    await appendEvent(
      ev,
      { mint: row.mint, tradeId: String(row.id), from, to },
      `trade-${to.toLowerCase()}:${row.id}`
    );
  }
  return row;
}
