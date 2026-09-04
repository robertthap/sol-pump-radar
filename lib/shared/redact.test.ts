import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecretsInString, redactEndpoint, REDACTED } from "@/lib/shared/redact";

/**
 * A synthetic secret in the same shape as the real one that leaked (a UUID
 * api-key on a Helius WSS URL). Never use a real credential in a test.
 */
const SECRET = "ec77e6de-0000-0000-0000-aaaaaaaaaaaa";
const WSS = `wss://mainnet.helius-rpc.com/?api-key=${SECRET}`;
const HTTPS = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;

describe("redactSecretsInString", () => {
  it("removes an api-key query parameter", () => {
    const out = redactSecretsInString(WSS);
    assert.ok(!out.includes(SECRET), `secret leaked: ${out}`);
    assert.ok(out.includes("helius-rpc.com"), "host must survive for debugging");
  });

  it("scrubs a credential embedded in an error message", () => {
    const err = `Error: connect ECONNREFUSED ${WSS} after 3 retries`;
    const out = redactSecretsInString(err);
    assert.ok(!out.includes(SECRET));
    assert.ok(out.includes("ECONNREFUSED"), "message context must survive");
  });

  it("covers the common credential parameter names", () => {
    for (const k of ["api-key", "api_key", "apikey", "key", "token", "access_token", "auth", "password", "secret"]) {
      const out = redactSecretsInString(`https://h/?${k}=${SECRET}`);
      assert.ok(!out.includes(SECRET), `${k} not scrubbed: ${out}`);
    }
  });

  it("scrubs a credential in a non-leading query position", () => {
    const out = redactSecretsInString(`https://h/?cluster=mainnet&api-key=${SECRET}&x=1`);
    assert.ok(!out.includes(SECRET));
    assert.ok(out.includes("cluster=mainnet") && out.includes("x=1"), "other params survive");
  });

  it("scrubs URL userinfo credentials", () => {
    const out = redactSecretsInString(`postgresql://sol:hunter2@127.0.0.1:5432/solpump`);
    assert.ok(!out.includes("hunter2"), `password leaked: ${out}`);
    assert.ok(out.includes("127.0.0.1:5432"), "host must survive");
  });

  it("leaves credential-free strings untouched", () => {
    const clean = "wss://api.mainnet-beta.solana.com";
    assert.equal(redactSecretsInString(clean), clean);
  });
});

describe("redactEndpoint", () => {
  it("redacts the parameter but keeps the endpoint identifiable", () => {
    const out = redactEndpoint(WSS)!;
    assert.ok(!out.includes(SECRET));
    assert.ok(out.includes("mainnet.helius-rpc.com"));
    assert.ok(out.includes(REDACTED) || out.includes(encodeURIComponent(REDACTED)));
  });

  it("handles http as well as websocket schemes", () => {
    assert.ok(!redactEndpoint(HTTPS)!.includes(SECRET));
  });

  it("passes through null/undefined", () => {
    assert.equal(redactEndpoint(null), null);
    assert.equal(redactEndpoint(undefined), null);
  });

  it("falls back to string scrubbing for an unparseable value", () => {
    const out = redactEndpoint(`not a url api-key=${SECRET}`)!;
    assert.ok(!out.includes(SECRET));
  });
});
