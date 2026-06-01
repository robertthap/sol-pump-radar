"use client";

import { useState } from "react";

export function ResetModal({
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, startSol?: number) => void;
}) {
  const [reason, setReason] = useState("");
  const [startSol, setStartSol] = useState<string>("");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded border border-border bg-panel p-4 shadow-lg">
        <h2 className="text-lg font-semibold">Reset paper portfolio</h2>
        <p className="mt-2 text-sm text-muted">
          This will close all open positions at the latest available price, archive the
          current session, and start a new session with a fresh balance.{" "}
          <strong>Trade history is preserved.</strong>
        </p>

        <label className="mt-4 block text-xs uppercase tracking-wider text-muted">
          Reason (for the audit log)
          <input
            type="text"
            className="mt-1 w-full rounded border border-border bg-bg p-2 text-sm text-fg"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="testing slippage model"
            maxLength={200}
          />
        </label>

        <label className="mt-3 block text-xs uppercase tracking-wider text-muted">
          Starting balance (leave blank for PAPER_START_SOL)
          <input
            type="number"
            min={0.1}
            step={0.1}
            className="mt-1 w-full rounded border border-border bg-bg p-2 text-sm text-fg"
            value={startSol}
            onChange={(e) => setStartSol(e.target.value)}
            placeholder="10"
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-bg/40"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded border border-bad/40 bg-bad/10 px-3 py-1.5 text-sm text-bad hover:bg-bad/20 disabled:opacity-50"
            disabled={pending || reason.trim().length === 0}
            onClick={() => {
              const s = startSol.trim() === "" ? undefined : Number(startSol);
              onConfirm(reason.trim(), s != null && Number.isFinite(s) && s > 0 ? s : undefined);
            }}
          >
            {pending ? "Resetting…" : "Confirm reset"}
          </button>
        </div>
      </div>
    </div>
  );
}
