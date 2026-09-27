"use client";

import { useId, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { TickerClosedPosition } from "@/lib/auto/ticker-snapshot";
import { CopyMintButton } from "@/components/ticker/CopyMintButton";
import {
  arrowOf,
  closeReasonWords,
  dateTime,
  heldFor,
  mcap,
  plainSol,
  shortMint,
  signedPct,
  signedSol,
  toneClass,
  toneOf,
} from "@/components/ticker/format";

export function ClosedPositionRow({ position: c }: { position: TickerClosedPosition }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const tone = toneOf(c.pnlSol);
  const pct = c.pnlSol != null && c.sizeSol > 0 ? c.pnlSol / c.sizeSol : null;
  const label = c.name?.trim() || c.symbol?.trim() || "Unknown token";
  const identity =
    c.symbol?.trim() && c.symbol.trim() !== label
      ? `$${c.symbol.trim()} · ${shortMint(c.mint)}`
      : shortMint(c.mint);

  return (
    <li
      className={`border-b border-border border-l-2 last:border-b-0 ${
        tone === "up" ? "border-l-ok/60" : tone === "down" ? "border-l-bad/60" : "border-l-border"
      }`}
    >
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-panel2"
        >
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
          <span className="block min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-semibold tracking-tight">{label}</span>
              <span className="pill shrink-0 text-[10px] uppercase tracking-wide text-muted">
                {c.source === "live" ? "Real" : "Paper"}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted">
              {identity} · {plainSol(c.sizeSol)}
            </span>
            <span className="mt-0.5 block text-xs text-muted tabular-nums">
              {closeReasonWords(c.exitReason)} · held {heldFor(c.openedAt, c.closedAt)}
            </span>
          </span>
          <span className={`block shrink-0 text-right tabular-nums ${toneClass(tone)}`}>
            <span className="block font-semibold">
              <span aria-hidden="true">{arrowOf(tone)} </span>
              {signedSol(c.pnlSol, 4)}
            </span>
            <span className="block text-xs">{signedPct(pct)}</span>
          </span>
        </button>
        <CopyMintButton mint={c.mint} tokenLabel={label} className="my-2 px-2" />
      </div>

      <div id={panelId} hidden={!open} className="bg-bg/40 px-3 pb-3 pt-2">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <Field label="Entry market cap" value={mcap(c.entryMcapUsd)} />
          <Field label="Exit market cap" value={mcap(c.exitMcapUsd)} />
          <Field label="Realized P&L" value={`${signedSol(c.pnlSol, 4)} (${signedPct(pct)})`} className={toneClass(tone)} />
          <Field label="Opened" value={dateTime(c.openedAt)} />
          <Field label="Closed" value={dateTime(c.closedAt)} />
          <Field label="Held" value={heldFor(c.openedAt, c.closedAt)} />
          <Field label="Exit reason" value={closeReasonWords(c.exitReason)} />
          <Field label="Coin address" value={shortMint(c.mint)} title={c.mint} />
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <CopyMintButton mint={c.mint} tokenLabel={label} showText />
          <a
            href={`https://dexscreener.com/solana/${c.mint}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost inline-flex min-h-11 items-center gap-1.5 px-3 text-xs"
          >
            Open in DexScreener <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
      </div>
    </li>
  );
}

function Field({
  label,
  value,
  className,
  title,
}: {
  label: string;
  value: string;
  className?: string;
  title?: string;
}) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className={`font-medium tabular-nums ${className ?? "text-fg"}`} title={title}>
        {value}
      </dd>
    </div>
  );
}
