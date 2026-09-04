/**
 * Credential scrubbing for log/diagnostic output (no server-only — testable).
 *
 * The logger already redacts by KEY NAME (`api_key`, `secret`, `token`, …) and by
 * base58 shape. Neither caught the real leak: an RPC endpoint logged under the
 * key `url`, whose value is a URL — not base58, and the key name is innocuous.
 * So the Helius API key was written in cleartext on every connect and on every
 * 30s stats line.
 *
 * These helpers scrub the VALUE, so they catch any string that happens to carry a
 * credential — including error messages that embed the endpoint they failed on.
 */

/**
 * `name=value` credential pairs. The prefix deliberately allows whitespace and
 * punctuation as well as URL delimiters, because credentials also show up in
 * free-form error text ("failed: api-key=..."), not only inside a query string.
 * Over-redacting a log line is strictly better than leaking one.
 */
const CREDENTIAL_PARAMS =
  /((?:^|[?&#\s,;:(["'`])(?:api[-_]?key|apikey|key|token|access[-_]?token|auth|authorization|password|passwd|pwd|secret|session)=)[^&#\s"'`)\]]*/gi;

/** `scheme://user:pass@host` — the password half of URL userinfo. */
const URL_USERINFO = /(\/\/)[^/@\s:]+:[^/@\s]*@/g;

export const REDACTED = "[redacted]";

/**
 * Remove credentials from any string while keeping it identifiable for
 * debugging — the host and path survive, only the secret is replaced.
 */
export function redactSecretsInString(input: string): string {
  return input
    .replace(CREDENTIAL_PARAMS, `$1${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`);
}

/**
 * Endpoint form safe to store in shared stats and to serve over the API.
 * Falls back to string scrubbing when the value is not a parseable URL.
 */
export function redactEndpoint(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = REDACTED;
      u.password = "";
    }
    for (const key of [...u.searchParams.keys()]) {
      if (/^(api[-_]?key|apikey|key|token|access[-_]?token|auth|authorization|password|passwd|pwd|secret|session)$/i.test(key)) {
        u.searchParams.set(key, REDACTED);
      }
    }
    return u.toString();
  } catch {
    return redactSecretsInString(url);
  }
}
