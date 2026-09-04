/**
 * Insertion-ordered map with a hard size ceiling (no server-only — testable).
 *
 * Several long-lived worker caches were plain Maps keyed by mint with no TTL, no
 * LRU and no cleanup, so they grew for the lifetime of the process — one entry
 * for every mint the system had ever seen. Individually small, but the worker is
 * a multi-day daemon and pump.fun mints churn constantly.
 *
 * This is deliberately NOT a full LRU. These caches are keyed by mint and read
 * shortly after write, so oldest-inserted is a good enough victim and keeps the
 * implementation to something obviously correct. `set` on an existing key
 * refreshes its position, which gives recency for the keys that matter.
 */
export class BoundedMap<K, V> {
  private readonly m = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new RangeError(`BoundedMap maxSize must be >= 1, got ${maxSize}`);
    }
  }

  get size(): number {
    return this.m.size;
  }

  has(k: K): boolean {
    return this.m.has(k);
  }

  get(k: K): V | undefined {
    return this.m.get(k);
  }

  set(k: K, v: V): this {
    // Re-inserting moves the key to the newest position, so hot keys survive.
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.maxSize) {
      const oldest = this.m.keys().next();
      if (oldest.done) break;
      this.m.delete(oldest.value);
    }
    return this;
  }

  delete(k: K): boolean {
    return this.m.delete(k);
  }

  clear(): void {
    this.m.clear();
  }
}

/** Set counterpart, same eviction rule. */
export class BoundedSet<T> {
  private readonly s = new Set<T>();

  constructor(private readonly maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new RangeError(`BoundedSet maxSize must be >= 1, got ${maxSize}`);
    }
  }

  get size(): number {
    return this.s.size;
  }

  has(v: T): boolean {
    return this.s.has(v);
  }

  add(v: T): this {
    if (this.s.has(v)) return this;
    this.s.add(v);
    while (this.s.size > this.maxSize) {
      const oldest = this.s.values().next();
      if (oldest.done) break;
      this.s.delete(oldest.value);
    }
    return this;
  }

  delete(v: T): boolean {
    return this.s.delete(v);
  }
}
