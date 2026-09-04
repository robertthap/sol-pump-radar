import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logger } from "@/lib/log";

/**
 * Regression: a known secret must never reach the log sink.
 *
 * The real leak was an RPC endpoint logged under the key `url` — the existing
 * key-name redaction did not match `url`, and a URL is not base58, so the
 * shape-based rule did not match either. These tests capture actual console
 * output and assert the secret is absent from the emitted line.
 */
const SECRET = "ec77e6de-0000-0000-0000-aaaaaaaaaaaa";
const ENDPOINT = `wss://mainnet.helius-rpc.com/?api-key=${SECRET}`;

let captured: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };

function capture(...args: unknown[]) {
  captured.push(args.map(String).join(" "));
}

beforeEach(() => {
  captured = [];
  console.log = capture;
  console.warn = capture;
  console.error = capture;
});

afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
});

const all = () => captured.join("\n");

describe("logger secret redaction", () => {
  const log = logger("test");

  it("does not emit a secret carried under an innocuous key (the real leak)", () => {
    log.info("connecting", { url: ENDPOINT });
    assert.ok(captured.length > 0, "nothing was logged");
    assert.ok(!all().includes(SECRET), `SECRET LEAKED: ${all()}`);
    assert.ok(all().includes("helius-rpc.com"), "host should survive for debugging");
  });

  it("does not emit a secret under any of the endpoint-ish key names", () => {
    log.info("open", { endpoint: ENDPOINT });
    log.info("rpc", { rpcUrl: ENDPOINT });
    log.info("cfg", { wss: ENDPOINT });
    assert.ok(!all().includes(SECRET), `SECRET LEAKED: ${all()}`);
  });

  it("does not emit a secret embedded in an error string", () => {
    log.warn("ws error", { err: `Error: ECONNREFUSED ${ENDPOINT}` });
    assert.ok(!all().includes(SECRET), `SECRET LEAKED: ${all()}`);
  });

  it("does not emit a secret embedded in the message itself", () => {
    log.error(`failed to reach ${ENDPOINT}`);
    assert.ok(!all().includes(SECRET), `SECRET LEAKED: ${all()}`);
  });

  it("does not emit a secret nested inside an object or array", () => {
    log.info("nested", { a: { b: [{ endpoint: ENDPOINT }] } });
    assert.ok(!all().includes(SECRET), `SECRET LEAKED: ${all()}`);
  });

  it("does not emit a DB password from a connection string", () => {
    log.info("db", { dsn: "postgresql://sol:hunter2@127.0.0.1:5432/solpump" });
    assert.ok(!all().includes("hunter2"), `PASSWORD LEAKED: ${all()}`);
  });

  it("still redacts by key name (pre-existing behaviour preserved)", () => {
    log.info("cfg", { apiKey: "plain-value-not-a-url" });
    assert.ok(!all().includes("plain-value-not-a-url"), `key-name redaction regressed: ${all()}`);
  });

  it("leaves ordinary diagnostic content intact", () => {
    log.info("ingestor stats", { sigs: 141422, dropped: 0, conn: "subscribed" });
    assert.ok(all().includes("141422") && all().includes("subscribed"));
  });
});
