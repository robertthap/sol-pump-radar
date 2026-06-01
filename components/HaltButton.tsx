"use client";
import { useState, useTransition } from "react";
import { HALT_LABEL, RESUME_LABEL } from "@/lib/ui/plain-labels";
import { postQueuedCommand } from "@/lib/trade-client";

export function HaltButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function halt() {
    setMsg(null);
    const res = await postQueuedCommand("/api/state/halt", { method: "POST" });
    if (!res.ok) {
      setMsg(res.error ?? "halt failed");
      return;
    }
    window.location.reload();
  }

  async function resume() {
    setMsg(null);
    const res = await postQueuedCommand("/api/state/resume", { method: "POST" });
    if (!res.ok) {
      setMsg(res.error ?? "resume failed");
      return;
    }
    window.location.reload();
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(halt)}
        className="btn-ghost btn-danger"
      >
        {HALT_LABEL}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(resume)}
        className="btn-ghost btn-ok"
      >
        {RESUME_LABEL}
      </button>
      {msg && <span className="text-[10px] text-bad">{msg}</span>}
    </div>
  );
}
