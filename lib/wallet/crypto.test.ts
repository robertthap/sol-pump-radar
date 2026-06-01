import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  blobFromString,
  blobToString,
  bytesEqual,
  decryptSecret,
  encryptSecret,
} from "./crypto";

test("encrypt → decrypt round-trips identical bytes", async () => {
  const secret = randomBytes(64);
  const blob = await encryptSecret(secret, "correct horse battery staple");
  const out = await decryptSecret(blob, "correct horse battery staple");
  assert.equal(out.byteLength, 64);
  assert.ok(bytesEqual(secret, out), "decrypted bytes must match original");
});

test("decryptSecret throws on wrong passphrase", async () => {
  const secret = randomBytes(64);
  const blob = await encryptSecret(secret, "right-pass");
  await assert.rejects(() => decryptSecret(blob, "wrong-pass"), /decryption failed/);
});

test("each encrypt yields a fresh salt + iv", async () => {
  const secret = randomBytes(32);
  const a = await encryptSecret(secret, "pass-1");
  const b = await encryptSecret(secret, "pass-1");
  assert.notEqual(a.ivB64, b.ivB64);
  assert.notEqual(a.kdfParams.saltB64, b.kdfParams.saltB64);
  assert.notEqual(a.ctB64, b.ctB64);
});

test("blob string round-trip preserves all fields", async () => {
  const secret = randomBytes(64);
  const blob = await encryptSecret(secret, "round-trip");
  const s = blobToString(blob);
  const back = blobFromString(s);
  const out = await decryptSecret(back, "round-trip");
  assert.ok(bytesEqual(secret, out));
});

test("rejects too-short passphrase", async () => {
  await assert.rejects(() => encryptSecret(randomBytes(8), "abc"), /too short/);
});
