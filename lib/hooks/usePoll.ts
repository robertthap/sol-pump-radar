"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

/** Poll with stale-while-revalidate — keeps last data visible while refreshing. */
export function usePoll<T>(
  fetcher: () => Promise<T | null>,
  intervalMs: number,
  deps: unknown[] = [],
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    try {
      const next = await fetcherRef.current();
      if (next != null) setData(next);
    } catch {
      /* keep stale */
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useVisibleInterval(load, intervalMs, [load]);

  return { data, loading, refresh: load };
}
