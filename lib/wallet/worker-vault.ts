import "server-only";
import { env } from "@/lib/env";
import { unlock, getStatus, lock } from "./session";
import { logger } from "@/lib/log";
import { appendEvent } from "@spr/core";

const log = logger("worker-vault");

/**
 * Worker-only wallet bootstrap.
 *
 * The signing keypair lives in the worker process only. Web cannot reach it
 * (enforced by ESLint barrier on @/lib/wallet/session).
 *
 * Auto-unlock policy:
 *   - If VAULT_PASSPHRASE is set in env, decrypt the vault at boot. This is
 *     the only supported live-execution path.
 *   - If VAULT_PASSPHRASE is empty, the worker boots with a locked wallet.
 *     Live trade intents will be rejected by the live-execution listener.
 */
export async function bootWorkerWallet(): Promise<{ unlocked: boolean; publicKey: string | null }> {
  const e = env();
  const status = await getStatus();
  if (!status.hasWallet) {
    log.info("no vault present — live execution disabled");
    await appendEvent({
      type: "WALLET_BOOT",
      payload: { unlocked: false, hasWallet: false, source: null },
    }).catch(() => undefined);
    return { unlocked: false, publicKey: null };
  }
  if (!e.VAULT_PASSPHRASE) {
    log.info("VAULT_PASSPHRASE not set — wallet remains locked");
    await appendEvent({
      type: "WALLET_BOOT",
      payload: { unlocked: false, hasWallet: true, source: status.source },
    }).catch(() => undefined);
    return { unlocked: false, publicKey: status.publicKey };
  }
  try {
    const r = await unlock(e.VAULT_PASSPHRASE);
    log.info("wallet auto-unlocked", { publicKey: r.publicKey });
    await appendEvent({
      type: "WALLET_BOOT",
      payload: { unlocked: true, hasWallet: true, source: status.source, publicKey: r.publicKey },
    }).catch(() => undefined);
    return { unlocked: true, publicKey: r.publicKey };
  } catch (e) {
    log.error("wallet auto-unlock failed", { err: String(e) });
    lock();
    await appendEvent({
      type: "WALLET_BOOT_FAILED",
      payload: { reason: String(e) },
    }).catch(() => undefined);
    return { unlocked: false, publicKey: status.publicKey };
  }
}
