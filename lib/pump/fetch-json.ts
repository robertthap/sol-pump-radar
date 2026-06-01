const DEFAULT_TIMEOUT_MS = 4_500;
/** Single-coin lookups during trading — fail fast, retry on next poll. */
export const PUMP_TRADE_TIMEOUT_MS = 2_000;

export async function fetchPumpJson<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
      next: { revalidate: 0 },
    });
    if (!r.ok) throw new Error(`pump.fun ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
