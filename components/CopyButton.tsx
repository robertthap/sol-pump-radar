"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/** Click-to-copy address chip. Shows a shortened label and a ✓ on copy. */
export function CopyButton({
  value,
  label,
  className = "",
  title = "Copy address",
}: {
  value: string;
  /** Display text; defaults to a shortened address. */
  label?: string;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const shown = label ?? (value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className={`inline-flex items-center gap-1 font-mono text-accent hover:text-fg ${className}`}
    >
      {shown}
      {copied ? (
        <Check className="h-3 w-3 text-ok" />
      ) : (
        <Copy className="h-3 w-3 opacity-60" />
      )}
    </button>
  );
}
