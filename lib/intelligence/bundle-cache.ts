import "server-only";
import {
  loadCommitInputBundle,
  type CommitInputBundle,
} from "@/lib/intelligence/commit-input";
import { intelEnv } from "@/lib/env";
import { onBusEvent } from "@/lib/arch/event-bus";

onBusEvent((ev) => {
  if (ev.type === "universe:refreshed" || ev.type === "ingest:flush") {
    invalidateCommitBundle();
  }
});

let cached: CommitInputBundle | null = null;
let cachedAt = 0;

export function peekCachedBundle(): CommitInputBundle | null {
  if (!cached) return null;
  if (Date.now() - cachedAt > intelEnv().bundleTtlMs) return null;
  return cached;
}

export function setCachedBundle(bundle: CommitInputBundle): void {
  cached = bundle;
  cachedAt = Date.now();
}

export async function getCommitInputBundle(opts?: {
  force?: boolean;
}): Promise<CommitInputBundle> {
  if (!opts?.force) {
    const hit = peekCachedBundle();
    if (hit) return hit;
  }
  const bundle = await loadCommitInputBundle();
  setCachedBundle(bundle);
  return bundle;
}

export function invalidateCommitBundle(): void {
  cached = null;
  cachedAt = 0;
}
