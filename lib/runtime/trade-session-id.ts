import "server-only";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";

/** Attach auto session id to trade intents when an auto session is active. */
export async function resolveTradeSessionId(): Promise<string | null> {
  try {
    const session = await getActiveSession();
    return session ? String(session.id) : null;
  } catch {
    return null;
  }
}
