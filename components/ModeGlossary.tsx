"use client";

import { useEffect, useRef, useState } from "react";
import { HelpCircle } from "lucide-react";

/**
 * Small "?" affordance that explains Demo vs Real sessions
 * in plain language (Task 4.1). Self-contained popover, no extra deps.
 */
export function ModeGlossary() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center rounded-md p-1 text-muted hover:bg-panel2 hover:text-muted"
        aria-label="What do Demo and Real mean?"
        title="What do Demo and Real mean?"
      >
        <HelpCircle className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-border bg-panel p-3 text-xs shadow-lg">
          <p className="mb-2 font-semibold text-fg">Demo vs Real</p>
          <p className="mb-2 text-muted">
            Pick one on the home page. While you trade, only that session is shown — use{" "}
            <span className="text-fg">Log off</span> to return home and choose again.
          </p>
          <p className="mb-1.5">
            <span className="rounded bg-ok/10 px-1.5 py-0.5 font-medium text-ok">
              Demo
            </span>{" "}
            <span className="text-muted">
              Virtual wallet, simulated (paper) fills. Safe to experiment — no crypto at risk.
            </span>
          </p>
          <p>
            <span className="rounded bg-warn/10 px-1.5 py-0.5 font-medium text-warn">
              Real
            </span>{" "}
            <span className="text-muted">
              Your connected wallet trades on-chain. Live orders only fire when the runtime profile
              and caps allow it.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
