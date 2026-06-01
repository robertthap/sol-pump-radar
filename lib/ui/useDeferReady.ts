"use client";

import { useEffect, useState } from "react";

/** Wait until after first paint before firing heavy fetches (keeps navigation snappy). */
export function useDeferReady(ms = 400): boolean {
  const [ready, setReady] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const t = window.setTimeout(() => setReady(true), ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return ready;
}
