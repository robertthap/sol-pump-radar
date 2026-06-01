import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { env } from "@/lib/env";
import { getDb } from "@/lib/db/client";
import { peekKeypair } from "@/lib/wallet/session";
import { notify } from "@/lib/notify";
import { readState } from "@/lib/circuit-breaker/state";

const log = logger("notifier");
const TICK_MS = 60_000;

/**
 * Background notifier — periodically polls a few lightweight conditions and
 * raises a notification if something interesting happened. Other code paths
 * (auto-trader, live executor, decision worker) call `notify()` directly when
 * they have specific events; this worker is the cross-cutting watchdog.
 */
export async function startNotifier() {
  log.info("notifier starting", {
    tickMs: TICK_MS,
    telegram: env().TELEGRAM_BOT_TOKEN ? "configured" : "off",
    discord: env().DISCORD_WEBHOOK_URL ? "configured" : "off",
  });

  let lastCbState = "RUNNING";
  let lastWalletUnlocked: boolean | null = null;
  let lastSessionId: string | null = null;

  async function tick() {
    try {
      const cb = await readState();
      if (cb.state !== lastCbState) {
        if (cb.state === "HALTED") {
          await notify({
            kind: "circuit_halted",
            title: "System halted",
            body: "Workers paused — resume from /api/state/resume",
            severity: "error",
          });
        } else if (cb.state === "RUNNING" && lastCbState === "HALTED") {
          await notify({
            kind: "circuit_resumed",
            title: "System resumed",
            severity: "info",
          });
        }
        lastCbState = cb.state;
      }

      const unlocked = !!peekKeypair();
      if (lastWalletUnlocked === true && unlocked === false) {
        // Wallet just auto-locked. Warn so user knows live trades will fail.
        const sess = await getDb().execute(sql`
          SELECT id::text FROM auto_sessions WHERE status='active' AND mode='live' LIMIT 1
        `);
        if ((sess as unknown as { rows: unknown[] }).rows.length > 0) {
          await notify({
            kind: "wallet_locked",
            title: "Wallet locked while live auto-trade is active",
            body: "Unlock from the home page to continue live trading. Practice mode is unaffected.",
            severity: "warn",
          });
        }
      }
      lastWalletUnlocked = unlocked;

      // Session lifecycle is announced from auto-sessions repo. We just refresh
      // lastSessionId so the dedupe in notify() works as expected.
      const a = await getDb().execute(sql`
        SELECT id::text AS id FROM auto_sessions WHERE status='active' LIMIT 1
      `);
      const id = ((a as unknown as { rows: Array<{ id: string }> }).rows[0]?.id) ?? null;
      lastSessionId = id;
    } catch (err) {
      log.warn("notifier tick failed", { err: String(err) });
    }
  }

  setTimeout(() => tick().catch(() => undefined), 5_000);
  const interval = setInterval(() => {
    tick().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(interval);
}
