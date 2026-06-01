import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * KDF parameters. Conservative defaults — scrypt N=32768 takes ~100ms on a
 * modern CPU which is the right ballpark for an interactive unlock.
 */
export type KdfParams = {
  N: number;
  r: number;
  p: number;
  dkLen: number;
  saltB64: string;
};

export type EncryptedBlob = {
  alg: "aes-256-gcm";
  kdf: "scrypt";
  kdfParams: KdfParams;
  ivB64: string;
  ctB64: string;
  tagB64: string;
};

const DEFAULT_KDF = { N: 32768, r: 8, p: 1, dkLen: 32 } as const;

async function deriveKey(passphrase: string, params: KdfParams): Promise<Buffer> {
  const salt = Buffer.from(params.saltB64, "base64");
  // scrypt's maxmem default is 32MB which is too small for N=32768; raise it.
  return await scrypt(passphrase, salt, params.dkLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export async function encryptSecret(
  secret: Uint8Array,
  passphrase: string,
): Promise<EncryptedBlob> {
  if (!passphrase || passphrase.length < 6) {
    throw new Error("passphrase too short (min 6 chars)");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdfParams: KdfParams = { ...DEFAULT_KDF, saltB64: salt.toString("base64") };
  const key = await deriveKey(passphrase, kdfParams);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      alg: "aes-256-gcm",
      kdf: "scrypt",
      kdfParams,
      ivB64: iv.toString("base64"),
      ctB64: ct.toString("base64"),
      tagB64: tag.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

export async function decryptSecret(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<Uint8Array> {
  if (blob.alg !== "aes-256-gcm" || blob.kdf !== "scrypt") {
    throw new Error("unsupported encryption blob");
  }
  const key = await deriveKey(passphrase, blob.kdfParams);
  try {
    const iv = Buffer.from(blob.ivB64, "base64");
    const tag = Buffer.from(blob.tagB64, "base64");
    const ct = Buffer.from(blob.ctB64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    // Return a fresh Uint8Array to avoid handing out the underlying pool buffer.
    return new Uint8Array(pt);
  } catch {
    // GCM tag mismatch shows up as an auth-failed exception. Surface a generic
    // error so we don't leak whether the salt/iv/ct/tag was the issue.
    throw new Error("decryption failed: wrong passphrase or corrupt blob");
  } finally {
    key.fill(0);
  }
}

/** Encode/decode for JSON storage. */
export function blobToString(blob: EncryptedBlob): string {
  return Buffer.from(JSON.stringify(blob), "utf8").toString("base64");
}

export function blobFromString(s: string): EncryptedBlob {
  const json = Buffer.from(s, "base64").toString("utf8");
  const parsed = JSON.parse(json) as EncryptedBlob;
  if (parsed.alg !== "aes-256-gcm" || parsed.kdf !== "scrypt") {
    throw new Error("unsupported blob format");
  }
  return parsed;
}

/** Constant-time byte comparison for the test suite. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
