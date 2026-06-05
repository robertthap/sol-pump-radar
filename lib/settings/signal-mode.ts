import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";
import { env, getEffectiveSignalMode, setSignalModeOverride, type SignalMode } from "@/lib/env";

/**
 * Persisted SIGNAL_MODE override (launch / hybrid / profit) so the strategy is
 * UI-selectable without an .env edit + restart. Stored in `user_settings`; loaded
 * into each process via {@link refreshSignalModeOverride} — the worker refreshes on
 * a timer (orchestrator), the web API on read/change.
 */
export const SIGNAL_MODE_KEY = "signal_mode";

const VALID = new Set<SignalMode>(["launch", "profit", "hybrid"]);

export function isSignalMode(v: unknown): v is SignalMode {
  return typeof v === "string" && VALID.has(v as SignalMode);
}

export async function getStoredSignalMode(): Promise<SignalMode | null> {
  const rows = await getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.key, SIGNAL_MODE_KEY))
    .limit(1);
  const v = rows[0]?.value;
  return isSignalMode(v) ? v : null;
}

/** Load the persisted override into THIS process. null → falls back to env default. */
export async function refreshSignalModeOverride(): Promise<SignalMode | null> {
  const stored = await getStoredSignalMode().catch(() => null);
  setSignalModeOverride(stored);
  return stored;
}

export function signalModeStatus(): { effective: SignalMode; envDefault: SignalMode } {
  return { effective: getEffectiveSignalMode(), envDefault: env().SIGNAL_MODE as SignalMode };
}
