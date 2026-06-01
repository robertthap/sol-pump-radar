"use client";

import { useEffect } from "react";

const RELOAD_KEY = "spr_chunk_reload_ts";

function isChunkLoadError(message: string) {
  return /ChunkLoadError|Loading chunk .* failed/i.test(message);
}

/** One automatic hard reload when a stale dev chunk fails to load (common after HMR). */
export function ChunkLoadRecovery() {
  useEffect(() => {
    function maybeReload(reason: string) {
      if (!isChunkLoadError(reason)) return;
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? "0");
      if (Date.now() - last < 15_000) return;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      window.location.reload();
    }

    const onError = (event: ErrorEvent) => {
      maybeReload(event.message || String(event.error ?? ""));
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const err = event.reason;
      const msg = err instanceof Error ? err.message : String(err ?? "");
      maybeReload(msg);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
