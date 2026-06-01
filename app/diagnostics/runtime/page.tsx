"use client";

import { useCallback, useEffect, useState } from "react";

type Report = Record<string, unknown>;

export default function RuntimeDiagnosticsPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/diagnostics/runtime", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReport((await r.json()) as Report);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/diagnostics/runtime?save=1", { cache: "no-store" });
      const j = (await r.json()) as { savedTo?: string; report?: Report };
      if (j.report) setReport(j.report);
      alert(j.savedTo ? `Saved to ${j.savedTo}` : "Saved");
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async () => {
    if (!report) return;
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <h1 className="text-lg font-semibold">Runtime diagnostics</h1>
      <p className="text-sm text-muted">
        Use this after pages feel slow. Browse the app for a minute, then refresh here or save a
        file to share with support.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Open Mission, Trade, Market (wait for slowness).</li>
        <li>Click <strong>Refresh report</strong> or <strong>Save JSON file</strong>.</li>
        <li>
          Send <code className="text-xs">data/diagnostics/runtime-latest.json</code> or copy JSON.
        </li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading…" : "Refresh report"}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save()}>
          Save JSON file
        </button>
        <button type="button" className="btn btn-ghost" disabled={!report} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <a href="/api/diagnostics/runtime" className="btn btn-ghost" target="_blank" rel="noreferrer">
          Raw API
        </a>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
      <pre className="card max-h-[70vh] overflow-auto p-3 text-[10px] leading-relaxed">
        {report ? JSON.stringify(report, null, 2) : "No data yet."}
      </pre>
    </main>
  );
}
