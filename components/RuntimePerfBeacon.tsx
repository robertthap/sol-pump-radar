"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const ENABLED =
  typeof window !== "undefined" &&
  (process.env.NODE_ENV === "development" ||
    window.localStorage.getItem("spr_perf") === "1");

type ClientSample = {
  kind: "navigation" | "resource" | "fetch" | "custom";
  name: string;
  ms: number;
  path?: string;
  detail?: Record<string, unknown>;
  at: number;
};

function navSample(path: string): ClientSample[] {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!nav) return [];

  return [
    {
      kind: "navigation",
      name: "document",
      path,
      ms: Math.round(nav.responseEnd - nav.fetchStart),
      at: Date.now(),
      detail: {
        ttfbMs: Math.round(nav.responseStart - nav.requestStart),
        downloadMs: Math.round(nav.responseEnd - nav.responseStart),
        domInteractiveMs: Math.round(nav.domInteractive - nav.fetchStart),
        loadEventMs: Math.round(nav.loadEventEnd - nav.fetchStart),
        transferSize: nav.transferSize,
      },
    },
  ];
}

function resourceSamples(path: string): ClientSample[] {
  return performance
    .getEntriesByType("resource")
    .filter((e) => {
      const n = e.name;
      return n.includes("/_next/") || n.includes("/api/");
    })
    .map((e) => ({
      kind: "resource" as const,
      name: e.name.split("/").slice(-2).join("/"),
      path,
      ms: Math.round(e.duration),
      at: Date.now(),
      detail: {
        initiatorType: (e as PerformanceResourceTiming).initiatorType,
        transferSize: (e as PerformanceResourceTiming).transferSize,
      },
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 12);
}

async function postSamples(samples: ClientSample[], path: string) {
  try {
    await fetch("/api/diagnostics/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samples, path }),
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}

/** Reports page load / chunk timing to the server perf buffer (dev or spr_perf=1). */
export function RuntimePerfBeacon() {
  const pathname = usePathname();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!ENABLED) return;
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;

    const send = () => {
      const samples = [...navSample(pathname), ...resourceSamples(pathname)];
      if (samples.length) void postSamples(samples, pathname);
    };

    if (document.readyState === "complete") {
      window.setTimeout(send, 300);
    } else {
      window.addEventListener("load", () => window.setTimeout(send, 300), { once: true });
    }
  }, [pathname]);

  return null;
}
