import "server-only";
import { Keypair } from "@solana/web3.js";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { blobFromString, decryptSecret } from "./crypto";
import { loadWallet } from "./storage";

const log = logger("wallet:session");

declare global {
  // eslint-disable-next-line no-var
  var __spr_wallet_session__:
    | {
        keypair: Keypair | null;
        publicKey: string | null;
        autoLockAt: number | null;
      }
    | undefined;
}

function state() {
  if (!globalThis.__spr_wallet_session__) {
    globalThis.__spr_wallet_session__ = {
      keypair: null,
      publicKey: null,
      autoLockAt: null,
    };
  }
  return globalThis.__spr_wallet_session__;
}

function autoLockMs(): number {
  return Math.max(1, env().WALLET_AUTO_LOCK_MINUTES) * 60_000;
}

function checkExpiry() {
  const s = state();
  if (s.autoLockAt != null && Date.now() >= s.autoLockAt) {
    s.keypair = null;
    s.publicKey = null;
    s.autoLockAt = null;
    log.info("auto-relock fired");
  }
}

export async function unlock(passphrase: string): Promise<{ publicKey: string }> {
  const row = await loadWallet();
  if (!row) throw new Error("no wallet to unlock");
  const blob = blobFromString(row.encryptedSecret);
  let secret: Uint8Array | null = null;
  try {
    secret = await decryptSecret(blob, passphrase);
    if (secret.byteLength !== 64) {
      throw new Error(`unexpected secret length: ${secret.byteLength}`);
    }
    const kp = Keypair.fromSecretKey(secret);
    const pub = kp.publicKey.toBase58();
    if (pub !== row.publicKey) {
      throw new Error("decoded public key does not match stored public key");
    }
    const s = state();
    s.keypair = kp;
    s.publicKey = pub;
    s.autoLockAt = Date.now() + autoLockMs();
    log.info("wallet unlocked", { publicKey: pub });
    return { publicKey: pub };
  } finally {
    if (secret) {
      // best-effort scrub
      for (let i = 0; i < secret.length; i++) secret[i] = 0;
    }
  }
}

export function lock(): void {
  const s = state();
  s.keypair = null;
  s.publicKey = null;
  s.autoLockAt = null;
  log.info("wallet locked");
}

export function getActiveKeypair(): Keypair | null {
  checkExpiry();
  const s = state();
  if (!s.keypair) return null;
  // Touch lock timer on access (keepalive).
  s.autoLockAt = Date.now() + autoLockMs();
  return s.keypair;
}

export function peekKeypair(): Keypair | null {
  checkExpiry();
  return state().keypair;
}

/**
 * Returns the public key of whichever wallet is currently in session, or null
 * when locked. Doesn't extend the auto-lock timer.
 */
export function getActivePubkey(): string | null {
  const kp = peekKeypair();
  return kp ? kp.publicKey.toBase58() : null;
}

export type WalletStatus = {
  hasWallet: boolean;
  isUnlocked: boolean;
  publicKey: string | null;
  autoLockAt: number | null;
  source: "generated" | "imported" | null;
};

export async function getStatus(): Promise<WalletStatus> {
  checkExpiry();
  const row = await loadWallet();
  const s = state();
  return {
    hasWallet: row != null,
    isUnlocked: s.keypair != null,
    publicKey: s.publicKey ?? row?.publicKey ?? null,
    autoLockAt: s.autoLockAt,
    source: row?.source ?? null,
  };
}
