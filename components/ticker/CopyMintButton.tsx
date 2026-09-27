"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

type Props = {
  mint: string;
  tokenLabel: string;
  className?: string;
  showText?: boolean;
};

export function CopyMintButton({ mint, tokenLabel, className = "", showText = false }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copyAddress() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(mint);
      } else {
        const input = document.createElement("textarea");
        input.value = mint;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copyAddress()}
      title={copied ? "Address copied" : "Copy coin address"}
      aria-label={`${copied ? "Copied" : "Copy"} ${tokenLabel} coin address`}
      className={`btn btn-ghost inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 px-3 text-xs ${
        copied ? "text-ok" : "text-muted"
      } ${className}`}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {showText && <span>{copied ? "Copied" : "Copy address"}</span>}
    </button>
  );
}
