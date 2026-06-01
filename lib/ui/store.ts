"use client";
import { useEffect, useState, useCallback } from "react";

const KEY = "spr:selectedMint";
const VSOL_KEY = "spr:selectedVSol";
const EVENT = "spr:selectedMint";
const VSOL_EVENT = "spr:selectedVSol";

/** Mint + optional vSol hint for instant demo/live trades without pump.fun round-trip. */
export function setSelectedMint(mint: string | null, vSol?: number | null): void {
  if (typeof window === "undefined") return;
  if (mint) {
    window.localStorage.setItem(KEY, mint);
  } else {
    window.localStorage.removeItem(KEY);
  }
  if (vSol != null && vSol > 0) {
    window.localStorage.setItem(VSOL_KEY, String(vSol));
  } else {
    window.localStorage.removeItem(VSOL_KEY);
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mint }));
  window.dispatchEvent(new CustomEvent(VSOL_EVENT, { detail: vSol ?? null }));
}

export function readSelectedVSol(): number | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(VSOL_KEY);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function useSelectedMint(): readonly [string | null, (m: string | null, vSol?: number | null) => void] {
  const [mint, setMint] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setMint(window.localStorage.getItem(KEY));
    function onChange(e: Event) {
      const detail = (e as CustomEvent<string | null>).detail;
      setMint(detail ?? null);
    }
    function onStorage(e: StorageEvent) {
      if (e.key === KEY) setMint(e.newValue);
    }
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const update = useCallback((next: string | null, vSol?: number | null) => {
    setSelectedMint(next, vSol);
  }, []);

  return [mint, update] as const;
}

export function useSelectedVSol(): number | null {
  const [vSol, setVSol] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setVSol(readSelectedVSol());
    function onChange(e: Event) {
      setVSol((e as CustomEvent<number | null>).detail ?? null);
    }
    function onStorage(e: StorageEvent) {
      if (e.key === VSOL_KEY) setVSol(readSelectedVSol());
    }
    window.addEventListener(VSOL_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(VSOL_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return vSol;
}
