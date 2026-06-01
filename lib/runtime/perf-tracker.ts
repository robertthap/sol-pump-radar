import "server-only";

export type ApiSample = {
  label: string;
  method: string;
  path: string;
  ms: number;
  status: number;
  at: number;
};

export type BootDbSample = {
  ms: number;
  cold: boolean;
  at: number;
};

export type CacheSample = {
  key: string;
  hit: boolean;
  ms: number;
  at: number;
};

export type ClientSample = {
  kind: "navigation" | "resource" | "fetch" | "custom";
  name: string;
  ms: number;
  path?: string;
  detail?: Record<string, unknown>;
  at: number;
};

type Store = {
  startedAt: number;
  api: ApiSample[];
  bootDb: BootDbSample[];
  cache: CacheSample[];
  client: ClientSample[];
  notes: string[];
};

const MAX_API = 120;
const MAX_BOOT = 40;
const MAX_CACHE = 80;
const MAX_CLIENT = 80;
const SLOW_API_MS = 400;
const SLOW_BOOT_MS = 50;

declare global {
  // eslint-disable-next-line no-var
  var __spr_perf_store__: Store | undefined;
}

function store(): Store {
  if (!globalThis.__spr_perf_store__) {
    globalThis.__spr_perf_store__ = {
      startedAt: Date.now(),
      api: [],
      bootDb: [],
      cache: [],
      client: [],
      notes: [],
    };
  }
  return globalThis.__spr_perf_store__;
}

export function perfEnabled(): boolean {
  return process.env.RUNTIME_PERF !== "off";
}

export function notePerf(msg: string) {
  if (!perfEnabled()) return;
  const s = store();
  s.notes.push(`${new Date().toISOString()} ${msg}`);
  if (s.notes.length > 30) s.notes.shift();
}

export function recordApiRequest(sample: Omit<ApiSample, "at"> & { at?: number }) {
  if (!perfEnabled()) return;
  const s = store();
  const row: ApiSample = { ...sample, at: sample.at ?? Date.now() };
  s.api.push(row);
  if (s.api.length > MAX_API) s.api.shift();
  if (row.ms >= SLOW_API_MS) {
    notePerf(`slow API ${row.label} ${row.ms}ms status=${row.status}`);
  }
}

export function recordBootDb(ms: number, cold: boolean) {
  if (!perfEnabled()) return;
  const s = store();
  s.bootDb.push({ ms, cold, at: Date.now() });
  if (s.bootDb.length > MAX_BOOT) s.bootDb.shift();
  if (ms >= SLOW_BOOT_MS) {
    notePerf(`bootDb ${ms}ms cold=${cold}`);
  }
}

export function recordCache(key: string, hit: boolean, ms: number) {
  if (!perfEnabled()) return;
  const s = store();
  s.cache.push({ key, hit, ms, at: Date.now() });
  if (s.cache.length > MAX_CACHE) s.cache.shift();
}

export function recordClient(samples: ClientSample[]) {
  if (!perfEnabled()) return;
  const s = store();
  for (const row of samples) {
    s.client.push(row);
    if (s.client.length > MAX_CLIENT) s.client.shift();
  }
}

function summarizeApi(samples: ApiSample[]) {
  const byPath = new Map<string, { count: number; totalMs: number; maxMs: number; lastStatus: number }>();
  for (const s of samples) {
    const cur = byPath.get(s.label) ?? { count: 0, totalMs: 0, maxMs: 0, lastStatus: s.status };
    cur.count += 1;
    cur.totalMs += s.ms;
    cur.maxMs = Math.max(cur.maxMs, s.ms);
    cur.lastStatus = s.status;
    byPath.set(s.label, cur);
  }
  return [...byPath.entries()]
    .map(([label, v]) => ({
      label,
      count: v.count,
      avgMs: Math.round(v.totalMs / v.count),
      maxMs: v.maxMs,
      lastStatus: v.lastStatus,
    }))
    .sort((a, b) => b.maxMs - a.maxMs);
}

function summarizeBoot(samples: BootDbSample[]) {
  if (samples.length === 0) return null;
  const cold = samples.filter((s) => s.cold);
  const warm = samples.filter((s) => !s.cold);
  const avg = (arr: BootDbSample[]) =>
    arr.length ? Math.round(arr.reduce((a, s) => a + s.ms, 0) / arr.length) : 0;
  return {
    calls: samples.length,
    coldCalls: cold.length,
    avgColdMs: avg(cold),
    avgWarmMs: avg(warm),
    maxMs: Math.max(...samples.map((s) => s.ms)),
  };
}

function summarizeCache(samples: CacheSample[]) {
  const byKey = new Map<string, { hits: number; misses: number; missMs: number }>();
  for (const s of samples) {
    const cur = byKey.get(s.key) ?? { hits: 0, misses: 0, missMs: 0 };
    if (s.hit) cur.hits += 1;
    else {
      cur.misses += 1;
      cur.missMs += s.ms;
    }
    byKey.set(s.key, cur);
  }
  return [...byKey.entries()]
    .map(([key, v]) => ({
      key,
      hits: v.hits,
      misses: v.misses,
      avgMissMs: v.misses ? Math.round(v.missMs / v.misses) : 0,
    }))
    .sort((a, b) => b.avgMissMs - a.avgMissMs);
}

export function buildPerfReport(extra?: Record<string, unknown>) {
  const s = store();
  const mem = process.memoryUsage();
  const uptimeSec = Math.round((Date.now() - s.startedAt) / 1000);

  const slowApi = [...s.api].sort((a, b) => b.ms - a.ms).slice(0, 25);
  const slowClient = [...s.client].sort((a, b) => b.ms - a.ms).slice(0, 25);

  return {
    generatedAt: new Date().toISOString(),
    uptimeSec,
    nodeEnv: process.env.NODE_ENV,
    runtimePerf: process.env.RUNTIME_PERF ?? "on (default)",
    workers: process.env.WORKERS,
    workersBootDelayMs: process.env.WORKERS_BOOT_DELAY_MS,
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    summary: {
      apiRequestsTracked: s.api.length,
      bootDbCalls: s.bootDb.length,
      cacheEvents: s.cache.length,
      clientEvents: s.client.length,
    },
    apiByRoute: summarizeApi(s.api),
    slowestApi: slowApi,
    bootDb: summarizeBoot(s.bootDb),
    cacheByKey: summarizeCache(s.cache),
    slowestClient: slowClient,
    recentNotes: s.notes.slice(-15),
    howToShare:
      "Open /api/diagnostics/runtime?save=1 then send data/diagnostics/runtime-latest.json, or copy JSON from /diagnostics/runtime",
    ...extra,
  };
}

export function resetPerfStore() {
  globalThis.__spr_perf_store__ = undefined;
}
