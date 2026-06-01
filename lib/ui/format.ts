export function shortAddr(addr: string | null | undefined, head = 4, tail = 4): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function fmtClock(iso: string | number | Date | null | undefined, withSeconds = false): string {
  if (iso == null) return "—";
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  });
}

export function relTime(iso: string | number | Date | null | undefined, nowMs?: number): string {
  if (iso == null) return "—";
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const now = nowMs ?? Date.now();
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 1) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86_400)}d`;
}

export function fmtSol(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(digits);
  if (Math.abs(v) >= 0.001) return v.toFixed(digits);
  return v.toExponential(2);
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export function solscanAddr(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

export function pumpfunCoin(mint: string): string {
  return `https://pump.fun/coin/${mint}`;
}
