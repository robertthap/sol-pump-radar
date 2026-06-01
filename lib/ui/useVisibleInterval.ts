"use client";
import { useEffect, useRef } from "react";

function safeInvoke(fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
  } catch {
    /* ignore sync throws */
  }
}

/** Poll only while the tab is visible; skips backlog when user returns. */
export function useVisibleInterval(fn: () => void | Promise<void>, ms: number, deps: unknown[] = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (id || ms <= 0) return;
      safeInvoke(() => fnRef.current());
      id = setInterval(() => safeInvoke(() => fnRef.current()), ms);
    }
    function stop() {
      if (id) {
        clearInterval(id);
        id = null;
      }
    }
    function onVis() {
      if (document.hidden) stop();
      else start();
    }

    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
