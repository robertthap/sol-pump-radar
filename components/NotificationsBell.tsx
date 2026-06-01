"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Row = {
  id: string;
  ts: string;
  kind: string;
  title: string;
  body: string | null;
  mint: string | null;
  severity: "info" | "warn" | "error" | "win" | "loss";
};

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function severityCls(s: Row["severity"]): string {
  if (s === "win") return "border-ok/40 text-ok";
  if (s === "loss") return "border-bad/40 text-bad";
  if (s === "error") return "border-bad/60 text-bad";
  if (s === "warn") return "border-warn/40 text-warn";
  return "border-border text-muted";
}

export function NotificationsBell({
  pollClosedMs = 45_000,
  deferMs = 3_000,
}: {
  pollClosedMs?: number;
  deferMs?: number;
} = {}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(deferMs <= 0);
  const [seenAt, setSeenAt] = useState<number>(() => {
    if (typeof window === "undefined") return Date.now();
    const v = window.localStorage.getItem("spr_notif_seen_at");
    return v ? Number(v) : 0;
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (deferMs <= 0) return;
    const t = window.setTimeout(() => setReady(true), deferMs);
    return () => window.clearTimeout(t);
  }, [deferMs]);

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await fetch("/api/notifications?limit=30", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { rows: Row[] };
      setRows(j.rows);
    } catch {
      /* ignore */
    }
  }, [ready]);

  useEffect(() => {
    if (ready) void refresh();
  }, [refresh, ready]);

  useVisibleInterval(refresh, ready ? (open ? 20_000 : pollClosedMs) : 0, [
    refresh,
    open,
    pollClosedMs,
    ready,
  ]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }
  }, [open]);

  const unread = rows.filter((r) => new Date(r.ts).getTime() > seenAt).length;

  function markRead() {
    const now = Date.now();
    setSeenAt(now);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("spr_notif_seen_at", String(now));
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn btn-ghost relative"
        onClick={() => {
          if (!open) markRead();
          setOpen((x) => !x);
        }}
        title="Notifications"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[360px] max-w-[90vw] overflow-hidden rounded-md border border-border bg-panel shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Notifications
            </span>
            <Link
              href="/notifications"
              className="text-[10px] text-accent hover:underline"
              onClick={() => setOpen(false)}
            >
              View all →
            </Link>
          </div>
          <div className="max-h-[400px] overflow-auto">
            {rows.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted">no alerts yet</div>
            ) : (
              rows.map((n) => (
                <div
                  key={n.id}
                  className={`border-b border-border/40 px-3 py-2 ${
                    new Date(n.ts).getTime() > seenAt ? "bg-bg/40" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className={`pill-side ${severityCls(n.severity)}`}>{n.kind}</span>
                    <span className="text-muted">{relTime(n.ts)}</span>
                  </div>
                  <div className="mt-1 text-xs font-medium">{n.title}</div>
                  {n.body && <div className="text-[11px] text-muted">{n.body}</div>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
