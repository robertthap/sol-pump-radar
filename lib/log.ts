import { env } from "./env";
import { redactSecretsInString } from "./shared/redact";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN =
  /(api_?key|secret|token|password|passphrase|seed|mnemonic|private|secret_?key|encrypted_?secret)/i;

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (value.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) {
      return value.slice(0, 4) + "..." + value.slice(-4);
    }
    // Key-name redaction misses a credential carried in an innocuously-named
    // field (the RPC endpoint was logged as `url`), so scrub the value too.
    return redactSecretsInString(value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < order[env().LOG_LEVEL]) return;
  const line = {
    t: new Date().toISOString(),
    lvl: level,
    scope,
    msg: redactSecretsInString(msg),
    ...(extra ? { extra: redact(extra) } : {}),
  };
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(JSON.stringify(line));
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e),
  };
}
