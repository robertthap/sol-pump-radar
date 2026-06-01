"use client";

const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, { at: number; data: unknown }>();

/** Dedupe concurrent GETs and optionally cache JSON for a few seconds (per tab). */
export async function getJson<T>(url: string, ttlMs = 0): Promise<T | null> {
  const now = Date.now();
  if (ttlMs > 0) {
    const hit = cache.get(url);
    if (hit && now - hit.at < ttlMs) return hit.data as T;
  }

  let pending = inflight.get(url) as Promise<T | null> | undefined;
  if (!pending) {
    const t0 = Date.now();
    pending = fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .catch(() => null)
      .finally(() => {
        inflight.delete(url);
        if (url.startsWith("/api/") && typeof window !== "undefined") {
          const track =
            process.env.NODE_ENV === "development" ||
            window.localStorage.getItem("spr_perf") === "1";
          if (track) {
            const ms = Date.now() - t0;
            void fetch("/api/diagnostics/runtime", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                samples: [
                  {
                    kind: "fetch",
                    name: url,
                    ms,
                    at: Date.now(),
                  },
                ],
              }),
              keepalive: true,
            }).catch(() => undefined);
          }
        }
      });
    inflight.set(url, pending);
  }

  const data = await pending;
  if (data != null && ttlMs > 0) cache.set(url, { at: now, data });
  return data;
}

export function invalidateClientGet(prefix?: string) {
  if (!prefix) {
    cache.clear();
    inflight.clear();
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
  for (const k of inflight.keys()) {
    if (k.startsWith(prefix)) inflight.delete(k);
  }
}
