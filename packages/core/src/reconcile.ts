import { getRuntimeDb, tradesFsm } from "@spr/db";
import { inArray } from "drizzle-orm";
import { appendEvent } from "./events";
import type { TradeFsmState } from "./trade-state";

/** In-memory projection: mint → latest non-terminal FSM state (rebuilt from DB only). */
export type TradeProjection = Map<string, TradeFsmState>;

export async function rebuildTradeProjection(): Promise<{
  projection: TradeProjection;
  openRows: (typeof tradesFsm.$inferSelect)[];
}> {
  const db = getRuntimeDb();
  const openRows = await db
    .select()
    .from(tradesFsm)
    .where(inArray(tradesFsm.state, ["INTENT", "OPEN", "CLOSING"]));
  const projection: TradeProjection = new Map();
  for (const row of openRows) {
    projection.set(row.mint, row.state as TradeFsmState);
  }
  return { projection, openRows };
}

export async function reconcileOnBoot(): Promise<TradeProjection> {
  const { projection, openRows } = await rebuildTradeProjection();
  await appendEvent("RECONCILE_BOOT", {
    open_fsm: openRows.length,
    mints: openRows.map((r) => r.mint),
  });
  return projection;
}
