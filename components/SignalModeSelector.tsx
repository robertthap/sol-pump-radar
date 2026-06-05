"use client";

import { useCallback, useEffect, useState } from "react";

type SignalMode = "launch" | "hybrid" | "profit";

const MODES: { id: SignalMode; label: string; blurb: string }[] = [
  {
    id: "launch",
    label: "Launch",
    blurb: "Snipe brand-new launches. Highest risk/reward — most rug.",
  },
  {
    id: "hybrid",
    label: "Hybrid",
    blurb: "Fresh launches + established movers. Balanced.",
  },
  {
    id: "profit",
    label: "Profit",
    blurb: "Established movers only. Conservative, lower variance.",
  },
];

/**
 * Strategy selector — switches the engine's hunting universe (SIGNAL_MODE) live,
 * from the UI, without editing .env or restarting. Persists server-side; the
 * worker applies it within a few seconds.
 */
export function SignalModeSelector() {
  const [mode, setMode] = useState<SignalMode | null>(null);
  const [busy, setBusy] = useState<SignalMode | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings/signal-mode", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { mode?: SignalMode; effective?: SignalMode };
      const m = j.effective ?? j.mode;
      if (m === "launch" || m === "hybrid" || m === "profit") setMode(m);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(m: SignalMode) {
    if (busy || m === mode) return;
    setBusy(m);
    setMsg(null);
    try {
      const r = await fetch("/api/settings/signal-mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: m }),
      });
      const j = (await r.json()) as { ok?: boolean; effective?: SignalMode; error?: string };
      if (r.ok && j.ok) {
        setMode(j.effective ?? m);
        setMsg("Strategy updated — the bot applies it within a few seconds.");
      } else {
        setMsg(j.error ?? "Couldn't update strategy");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Strategy</h2>
        <span className="text-[10px] text-muted">what the bot hunts</span>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {MODES.map((m) => {
          const selected = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              disabled={busy != null}
              onClick={() => void choose(m.id)}
              aria-pressed={selected}
              className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted hover:bg-panel2 hover:text-fg"
              }`}
            >
              <span className="flex items-center justify-between text-xs font-semibold">
                {m.label}
                {busy === m.id ? <span className="text-[10px]">…</span> : selected ? <span className="text-[10px]">●</span> : null}
              </span>
              <span className="mt-0.5 block text-[10px] leading-tight text-muted">{m.blurb}</span>
            </button>
          );
        })}
      </div>
      {msg && <p className="mt-2 text-[10px] text-muted">{msg}</p>}
    </section>
  );
}
