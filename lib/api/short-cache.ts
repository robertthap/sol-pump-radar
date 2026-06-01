import "server-only";

type Entry<T> = { at: number; data: T };

const store = new Map<string, Entry<unknown>>();

/** In-process TTL cache for hot read APIs (dev + single-user localhost). */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < ttlMs) {
    const { recordCache } = await import("@/lib/runtime/perf-tracker");
    recordCache(key, true, 0);
    return hit.data;
  }
  const t0 = Date.now();
  const data = await fn();
  store.set(key, { at: now, data });
  const { recordCache } = await import("@/lib/runtime/perf-tracker");
  recordCache(key, false, Date.now() - t0);
  return data;
}

export function invalidateCache(prefix?: string) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
