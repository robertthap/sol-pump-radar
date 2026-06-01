import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";
import { env } from "@/lib/env";

export type TradeLimits = {
  paperSizePerTradeSol: number;
  liveMaxPerTradeSol: number;
  liveMaxDailySol: number;
  source: "env" | "user";
  /** True when user has stored a custom live daily cap in DB. */
  customLiveMaxDaily: boolean;
};

const KEYS = {
  paperSize: "paper_size_per_trade_sol",
  liveMaxTrade: "live_max_per_trade_sol",
  liveMaxDaily: "live_max_daily_sol",
} as const;

async function readNum(key: string): Promise<number | null> {
  const rows = await getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.key, key))
    .limit(1);
  const v = rows[0]?.value;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function writeNum(key: string, value: number): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ key, value: String(value), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userSettings.key,
      set: { value: String(value), updatedAt: new Date() },
    });
}

async function deleteKey(key: string): Promise<void> {
  await getDb().delete(userSettings).where(eq(userSettings.key, key));
}

export async function getEffectiveTradeLimits(): Promise<TradeLimits> {
  const e = env();
  const [paper, liveTrade, liveDaily] = await Promise.all([
    readNum(KEYS.paperSize),
    readNum(KEYS.liveMaxTrade),
    readNum(KEYS.liveMaxDaily),
  ]);
  const hasUser = paper != null || liveTrade != null || liveDaily != null;
  return {
    paperSizePerTradeSol:
      paper ?? e.PAPER_SIZE_PER_TRADE_SOL ?? riskDefaultPaperSize(e.RISK_PRESET),
    liveMaxPerTradeSol: liveTrade ?? e.LIVE_MAX_PER_TRADE_SOL,
    liveMaxDailySol: liveDaily ?? e.LIVE_MAX_DAILY_SOL,
    source: hasUser ? "user" : "env",
    customLiveMaxDaily: liveDaily != null,
  };
}

function riskDefaultPaperSize(preset: string): number {
  switch (preset) {
    case "conservative":
      return 0.03;
    case "aggressive":
      return 0.1;
    default:
      return 0.05;
  }
}

export async function setTradeLimits(opts: {
  paperSizePerTradeSol?: number;
  liveMaxPerTradeSol?: number;
  liveMaxDailySol?: number;
  clearLiveMaxDaily?: boolean;
}): Promise<TradeLimits> {
  if (opts.paperSizePerTradeSol != null) {
    if (opts.paperSizePerTradeSol <= 0 || opts.paperSizePerTradeSol > 100) {
      throw new Error("paper_size must be between 0 and 100 SOL");
    }
    await writeNum(KEYS.paperSize, opts.paperSizePerTradeSol);
  }
  if (opts.liveMaxPerTradeSol != null) {
    if (opts.liveMaxPerTradeSol <= 0 || opts.liveMaxPerTradeSol > 500) {
      throw new Error("live_max_per_trade must be between 0 and 500 SOL");
    }
    await writeNum(KEYS.liveMaxTrade, opts.liveMaxPerTradeSol);
  }
  if (opts.clearLiveMaxDaily) {
    await deleteKey(KEYS.liveMaxDaily);
  } else if (opts.liveMaxDailySol != null) {
    if (opts.liveMaxDailySol <= 0 || opts.liveMaxDailySol > 2000) {
      throw new Error("live_max_daily must be between 0 and 2000 SOL");
    }
    await writeNum(KEYS.liveMaxDaily, opts.liveMaxDailySol);
  }
  return getEffectiveTradeLimits();
}
