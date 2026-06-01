"use client";
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { postQueuedCommand } from "@/lib/trade-client";

type Limits = {
  paperSizePerTradeSol: number;
  liveMaxPerTradeSol: number;
  liveMaxDailySol: number;
  source: "env" | "user";
  customLiveMaxDaily: boolean;
  envFloors: { liveMaxPerTradeSol: number; liveMaxDailySol: number };
  liveExecution: "on" | "off";
  liveDryRun: "on" | "off";
};

export function TradeLimitsEditor() {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [editing, setEditing] = useState(false);
  const [paper, setPaper] = useState("");
  const [perTrade, setPerTrade] = useState("");
  const [daily, setDaily] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmHigh, setConfirmHigh] = useState(false);
  const [customDaily, setCustomDaily] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings/limits", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as Limits;
        setLimits(j);
        setPaper(j.paperSizePerTradeSol.toString());
        setPerTrade(j.liveMaxPerTradeSol.toString());
        setDaily(j.liveMaxDailySol.toString());
        setCustomDaily(j.customLiveMaxDaily);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useVisibleInterval(() => void load(), 8_000, [load]);

  async function save() {
    if (busy) return;
    const p = Number(paper);
    const pt = Number(perTrade);
    const d = Number(daily);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(pt) || pt <= 0) {
      setMsg("paper and per-trade sizes must be positive numbers");
      return;
    }
    if (customDaily) {
      if (!Number.isFinite(d) || d <= 0) {
        setMsg("daily cap must be a positive number when enabled");
        return;
      }
      if (d < pt) {
        setMsg("daily must be ≥ per-trade");
        return;
      }
    }
    if (pt > 1 && !confirmHigh) {
      setMsg("per-trade > 1 SOL — tick confirm and save again");
      setConfirmHigh(true);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        paperSizePerTradeSol: p,
        liveMaxPerTradeSol: pt,
      };
      if (customDaily) {
        body.liveMaxDailySol = d;
      } else {
        body.clearLiveMaxDaily = true;
      }
      const res = await postQueuedCommand("/api/settings/limits", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setMsg(res.error ?? "save failed");
      } else {
        await load();
        setMsg("saved");
        setEditing(false);
        setConfirmHigh(false);
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!limits) {
    return <div className="card px-3 py-2 text-xs text-muted">loading limits…</div>;
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Trade limits
          <span
            className={`ml-2 pill ${
              limits.source === "user" ? "text-accent" : "text-muted"
            }`}
          >
            {limits.source}
          </span>
        </h3>
        {!editing ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setEditing(false);
                setConfirmHigh(false);
                setMsg(null);
                load();
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 px-3 py-2 text-xs sm:grid-cols-3">
        <Field
          label="Paper size / trade"
          unit="SOL"
          value={paper}
          onChange={setPaper}
          editing={editing}
          display={limits.paperSizePerTradeSol.toFixed(3)}
        />
        <Field
          label="Live cap / trade"
          unit="SOL"
          value={perTrade}
          onChange={setPerTrade}
          editing={editing}
          display={limits.liveMaxPerTradeSol.toFixed(3)}
        />
        <Field
          label="Live cap / day"
          unit="SOL"
          value={daily}
          onChange={setDaily}
          editing={editing && customDaily}
          display={
            limits.customLiveMaxDaily
              ? limits.liveMaxDailySol.toFixed(3)
              : `${limits.envFloors.liveMaxDailySol.toFixed(3)} (env default)`
          }
        />
      </div>
      {editing && (
        <label className="flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={customDaily}
            onChange={(e) => {
              setCustomDaily(e.target.checked);
              if (!e.target.checked) {
                setDaily(limits.envFloors.liveMaxDailySol.toString());
              }
            }}
            className="rounded"
          />
          Set custom daily live cap (uncheck to use server default{" "}
          {limits.envFloors.liveMaxDailySol.toFixed(2)} SOL)
        </label>
      )}
      {editing && Number(perTrade) > 1 && (
        <label className="flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-warn">
          <input
            type="checkbox"
            checked={confirmHigh}
            onChange={(e) => setConfirmHigh(e.target.checked)}
            className="accent-warn"
          />
          I understand a per-trade cap above 1 SOL means a single bug or bad
          signal can cost me {Number(perTrade).toFixed(2)} SOL.
        </label>
      )}
      {msg && (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
          {msg}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  unit,
  value,
  onChange,
  editing,
  display,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  editing: boolean;
  display: string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      {editing ? (
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="0.001"
            min="0"
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-panel px-2 py-1 font-mono text-xs"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="text-[10px] text-muted">{unit}</span>
        </div>
      ) : (
        <span className="font-mono text-sm">
          {display} <span className="text-[10px] text-muted">{unit}</span>
        </span>
      )}
    </label>
  );
}
