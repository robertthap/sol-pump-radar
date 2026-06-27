"use client";
import { useCallback, useMemo, useState } from "react";
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
  extra: Record<string, unknown> | null;
};

const SEVERITIES: Array<"all" | "info" | "warn" | "error" | "win" | "loss"> = [
  "all", "win", "loss", "warn", "error", "info",
];

function severityCls(s: Row["severity"]): string {
  if (s === "win") return "border-ok/40 text-ok";
  if (s === "loss") return "border-bad/40 text-bad";
  if (s === "error") return "border-bad/60 text-bad";
  if (s === "warn") return "border-warn/40 text-warn";
  return "border-border text-muted";
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function fullTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

export function NotificationsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [sev, setSev] = useState<(typeof SEVERITIES)[number]>("all");
  const [kind, setKind] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [seenAt, setSeenAt] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    return Number(window.localStorage.getItem("spr_notif_seen_at") ?? "0");
  });
  // "Clear all" hides everything up to this timestamp (the DB notify-log is kept;
  // newer notifications still appear). Persists per-browser like the seen watermark.
  const [clearedAt, setClearedAt] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    return Number(window.localStorage.getItem("spr_notif_cleared_at") ?? "0");
  });

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications?limit=200", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { rows: Row[] };
      setRows(j.rows);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useVisibleInterval(() => void load(), 8_000, [load]);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.kind);
    return ["all", ...Array.from(set).sort()];
  }, [rows]);

  const filtered = rows.filter(
    (r) =>
      (sev === "all" || r.severity === sev) &&
      (kind === "all" || r.kind === kind) &&
      new Date(r.ts).getTime() > clearedAt,
  );

  function markAllRead() {
    const now = Date.now();
    setSeenAt(now);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("spr_notif_seen_at", String(now));
    }
  }

  function clearAll() {
    // Clear everything currently loaded (use the newest ts in case of clock skew),
    // and also mark read so the header bell badge resets.
    const newest = rows.reduce((m, r) => Math.max(m, new Date(r.ts).getTime()), 0);
    const at = Math.max(Date.now(), newest);
    setClearedAt(at);
    setSeenAt(at);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("spr_notif_cleared_at", String(at));
      window.localStorage.setItem("spr_notif_seen_at", String(at));
    }
  }

  return (
    <div>
      <section className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Notifications</h1>
          <p className="text-sm text-muted">
            Auto-trade lifecycle, trade outcomes, circuit-breaker events, wallet status. Configured
            sinks: console (always) · Telegram (set <code>TELEGRAM_BOT_TOKEN</code> + <code>TELEGRAM_CHAT_ID</code>) ·
            Discord (set <code>DISCORD_WEBHOOK_URL</code>).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost text-xs" onClick={markAllRead}>
            Mark all read
          </button>
          <button
            type="button"
            className="btn btn-ghost text-xs text-muted hover:text-bad"
            onClick={clearAll}
            disabled={filtered.length === 0}
            title="Hide all current notifications (the log is kept; new ones still appear)"
          >
            Clear all
          </button>
        </div>
      </section>

      <section className="card mb-3 flex flex-wrap items-center gap-1 p-2">
        <span className="text-[10px] uppercase tracking-wider text-muted">Severity:</span>
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSev(s)}
            className={`px-2 py-1 text-xs ${
              sev === s
                ? "rounded-sm bg-accent/15 text-accent"
                : "text-muted hover:text-fg"
            }`}
          >
            {s}
          </button>
        ))}
        <span className="ml-3 text-[10px] uppercase tracking-wider text-muted">Kind:</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-md border border-border bg-bg/40 px-2 py-1 text-xs"
        >
          {kinds.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <span className="ml-auto text-[10px] text-muted">{filtered.length} / {rows.length}</span>
      </section>

      {loading && rows.length === 0 && (
        <div className="card p-3 text-xs text-muted">loading…</div>
      )}
      {err && <div className="card p-3 text-xs text-bad">{err}</div>}

      <section className="space-y-1">
        {filtered.length === 0 && !loading && (
          <div className="rounded-md border border-border bg-bg/40 p-4 text-center text-xs text-muted">
            no notifications match the current filters
          </div>
        )}
        {filtered.map((n) => {
          const unread = new Date(n.ts).getTime() > seenAt;
          return (
            <div
              key={n.id}
              className={`card flex flex-wrap items-start gap-3 px-3 py-2 ${
                unread ? "border-l-2 border-l-accent" : ""
              }`}
            >
              <div className="flex flex-col items-start gap-1">
                <span className={`pill-side ${severityCls(n.severity)}`}>{n.kind}</span>
                <span className={`text-[10px] uppercase tracking-wider ${severityCls(n.severity)}`}>
                  {n.severity}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{n.title}</div>
                {n.body && <div className="mt-0.5 text-xs text-muted">{n.body}</div>}
                {n.mint && (
                  <div className="mt-1">
                    <Link
                      href={`/token/${n.mint}`}
                      className="font-mono text-[10px] text-accent hover:underline"
                    >
                      {n.mint.slice(0, 6)}…{n.mint.slice(-4)}
                    </Link>
                  </div>
                )}
                {n.extra && Object.keys(n.extra).length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-muted hover:text-fg">extra</summary>
                    <pre className="mt-1 rounded border border-border/40 bg-bg/40 p-1 text-[10px] text-muted">
                      {JSON.stringify(n.extra, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
              <div className="text-right text-[10px] text-muted" title={fullTime(n.ts)}>
                {relTime(n.ts)}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
