"use client";

/** Collapse duplicate in-flight GETs (same URL within ~100ms). */
const inflight = new Map<string, Promise<Response>>();

export function fetchDedupe(url: string, init?: RequestInit): Promise<Response> {
  const key = `${init?.method ?? "GET"} ${url}`;
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = fetch(url, init).finally(() => {
    window.setTimeout(() => inflight.delete(key), 100);
  });
  inflight.set(key, p);
  return p;
}
