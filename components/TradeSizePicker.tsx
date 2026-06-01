"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TRADE_SIZE_PRESETS,
  fmtTradeSize,
  loadSelectedTradeSize,
  loadTradeSizePresets,
  normalizeTradeSizePresets,
  saveSelectedTradeSize,
  saveTradeSizePresets,
} from "@/lib/ui/trade-size-prefs";

type Props = {
  size: number;
  onSizeChange: (size: number) => void;
  className?: string;
};

export function TradeSizePicker({ size, onSizeChange, className }: Props) {
  const [presets, setPresets] = useState<number[]>([...DEFAULT_TRADE_SIZE_PRESETS]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(["", "", "", ""]);

  useEffect(() => {
    const loaded = loadTradeSizePresets();
    setPresets(loaded);
    onSizeChange(loadSelectedTradeSize(loaded));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load saved size once on mount
  }, []);

  const pick = useCallback(
    (s: number) => {
      onSizeChange(s);
      saveSelectedTradeSize(s);
    },
    [onSizeChange],
  );

  function openEdit() {
    setDraft(presets.map((p) => String(p)));
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
  }

  function saveEdit() {
    const nums = draft.map((s) => Number(s.trim()));
    const normalized = normalizeTradeSizePresets(nums);
    if (!normalized) {
      window.alert("Enter 4 different sizes between 0.001 and 5 SOL (no duplicates).");
      return;
    }
    saveTradeSizePresets(normalized);
    setPresets(normalized);
    setEditing(false);
    if (!normalized.includes(size)) {
      pick(normalized[1] ?? normalized[0]!);
    }
  }

  function resetDefaults() {
    const defaults = [...DEFAULT_TRADE_SIZE_PRESETS];
    saveTradeSizePresets(defaults);
    setPresets(defaults);
    setDraft(defaults.map(String));
    pick(defaults[1] ?? defaults[0]!);
  }

  if (editing) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
        <span className="text-muted">Edit sizes:</span>
        {draft.map((val, i) => (
          <label key={i} className="flex items-center gap-1 text-muted">
            <input
              type="number"
              min={0.001}
              max={5}
              step={0.001}
              value={val}
              onChange={(e) => {
                const next = [...draft];
                next[i] = e.target.value;
                setDraft(next);
              }}
              className="w-16 rounded border border-border bg-panel px-1.5 py-1 font-mono text-xs"
            />
            <span className="text-[10px]">SOL</span>
          </label>
        ))}
        <button
          type="button"
          onClick={saveEdit}
          className="rounded border border-accent/50 px-2 py-1 text-accent hover:bg-accent/10"
        >
          Save
        </button>
        <button type="button" onClick={cancelEdit} className="text-muted hover:underline">
          Cancel
        </button>
        <button type="button" onClick={resetDefaults} className="text-[10px] text-muted hover:underline">
          Reset defaults
        </button>
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      <span className="text-muted">Size:</span>
      {presets.map((s, i) => (
        <button
          key={`preset-${i}-${s}`}
          type="button"
          onClick={() => pick(s)}
          className={`rounded border px-2 py-1 ${
            size === s ? "border-accent text-accent" : "border-border text-muted"
          }`}
        >
          {fmtTradeSize(s)} SOL
        </button>
      ))}
      <button
        type="button"
        onClick={openEdit}
        className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-panel"
        title="Customize preset sizes"
      >
        Edit
      </button>
    </div>
  );
}
