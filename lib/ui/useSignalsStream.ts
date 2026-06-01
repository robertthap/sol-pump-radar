"use client";

import { useEffect, useRef, useState } from "react";

type StreamPayload = {
  ts: number;
  signals: unknown[];
  summary?: { total: number; autoEligible: number };
};

export function useSignalsStream(opts?: { intelligenceOnly?: boolean; autoGateOnly?: boolean }) {
  const [payload, setPayload] = useState<StreamPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (opts?.intelligenceOnly) params.set("intelligenceOnly", "1");
    if (opts?.autoGateOnly) params.set("autoGateOnly", "1");
    const url = `/api/signals/stream?${params.toString()}`;

    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onmessage = (ev) => {
      try {
        setPayload(JSON.parse(ev.data) as StreamPayload);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [opts?.intelligenceOnly, opts?.autoGateOnly]);

  return { payload, connected };
}
