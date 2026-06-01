import "server-only";
import { recordApiRequest } from "@/lib/runtime/perf-tracker";

type RouteHandler = (req: Request, ctx?: unknown) => Promise<Response>;

/** Wrap an App Router handler to record server-side duration (send report via /api/diagnostics/runtime). */
export function withRoutePerf(handler: RouteHandler): RouteHandler {
  return async (req: Request, ctx?: unknown) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const label = `${req.method} ${path}`;
    const t0 = Date.now();
    let status = 500;
    try {
      const res = await handler(req, ctx);
      status = res.status;
      return res;
    } finally {
      recordApiRequest({
        label,
        method: req.method,
        path,
        ms: Date.now() - t0,
        status,
      });
    }
  };
}
