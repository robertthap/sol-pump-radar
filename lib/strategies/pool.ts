import { BASE_TX_FEE, CURVE_K, DEX_FEE, EXECUTION, type ExecutionSetting, type TapeEvent } from "./catalog";

export type PoolState = { x: number; k: number };
export type Trade = TapeEvent & { sol: number; tokens: number; side: "buy" | "sell"; state: PoolState | null };
export const spot = (s: PoolState) => s.x * s.x / s.k;
const movedSol = (t: TapeEvent) => t.side === "buy" ? t.sol! * 0.9975 : t.sol! / 0.9975;
export function reserveBefore(k: number, t: TapeEvent): number {
  const dx = movedSol(t), dy = t.tokens!;
  return ((t.side === "buy" ? -1 : 1) * dx + Math.sqrt(dx * dx + 4 * k * dx / dy)) / 2;
}
export function ammPairK(a: TapeEvent, b: TapeEvent): number | null {
  const gap = (k: number) => reserveBefore(k, a) + (a.side === "buy" ? 1 : -1) * movedSol(a) - reserveBefore(k, b);
  let lo = 1e6, hi = 1e16, g = gap(lo);
  if (!Number.isFinite(g) || g * gap(hi) >= 0) return null;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi), gm = gap(mid);
    if (gm * g > 0) { lo = mid; g = gm; } else hi = mid;
  }
  return Math.sqrt(lo * hi);
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b), n = sorted.length;
  return (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2;
}

/** Reconstruct each state using only this trade and earlier consecutive trades. */
export function prepareTape(events: TapeEvent[], curve: boolean): Trade[] {
  const trades: Trade[] = [];
  const pairs: number[] = [];
  for (const event of events) {
    const valid = (event.side === "buy" || event.side === "sell") && event.sol != null && event.sol > 0 &&
      event.tokens != null && event.tokens > 0 && Number.isFinite(event.sol) && Number.isFinite(event.tokens);
    if (!valid) {
      pairs.length = 0;
      trades.push({ ...event, sol: event.sol ?? 0, tokens: event.tokens ?? 0, side: event.side === "sell" ? "sell" : "buy", state: null });
      continue;
    }
    let state: PoolState | null = null;
    if (curve) {
      if (event.vSol != null && Number.isFinite(event.vSol) && event.vSol >= 30 && event.vSol <= 115.005) {
        state = { x: event.vSol, k: CURVE_K };
      }
    } else {
      const prev = trades.at(-1);
      const k = prev && prev.sol > 0 && prev.tokens > 0 ? ammPairK(prev, event) : null;
      if (k != null) pairs.push(k); else pairs.length = 0;
      if (pairs.length > 10) pairs.shift();
      const estimate = pairs.length >= 3 ? median(pairs) : null;
      if (estimate != null) {
        const x = reserveBefore(estimate, event) + (event.side === "buy" ? 1 : -1) * movedSol(event);
        if (x > 0 && Number.isFinite(x)) state = { x, k: estimate };
      }
    }
    trades.push({ ...event, sol: event.sol!, tokens: event.tokens!, side: event.side as "buy" | "sell", state });
  }
  return trades;
}

export function beforeTime(tape: Trade[], ts: number): number {
  let lo = 0, hi = tape.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (tape[m].ts < ts) lo = m + 1; else hi = m; }
  return lo - 1;
}
export function beforeSlot(tape: Trade[], slot: number): number {
  let lo = 0, hi = tape.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (tape[m].slot < slot) lo = m + 1; else hi = m; }
  return lo - 1;
}
/** Whole-second timestamps require a 400ms slot assumption in quiet seconds. */
export function slotAt(tape: Trade[], ts: number): number {
  const i = beforeTime(tape, ts), next = tape[i + 1];
  if (next && next.ts < ts + 1) return next.slot;
  return i >= 0 ? tape[i].slot + Math.max(1, Math.round((ts - tape[i].ts) / 0.4)) : tape[0].slot;
}
export function timeAt(tape: Trade[], slot: number): number {
  const t = tape[Math.max(0, beforeSlot(tape, slot + 1))];
  return t.ts + (slot - t.slot) * 0.4;
}

/** Stable per-episode random draws: changing UI order cannot change fills. */
export function randomFor(key: string, seed = 1701): () => number {
  let h = seed >>> 0;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ h >>> 15, 1 | h); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Pool mechanics with fees outside the invariant and the open position's footprint. */
export function buyAt(state: PoolState, amount: number, footprint = 0, fee = DEX_FEE, adverse = 0) {
  const x = state.x + footprint, intoPool = amount * (1 - fee);
  return { tokens: (state.k / x) * intoPool / (x + intoPool) * (1 - adverse), intoPool };
}
export function sellAt(state: PoolState, tokens: number, footprint: number, fee = DEX_FEE, adverse = 0) {
  const x = state.x + footprint;
  return x * tokens / (state.k / x + tokens) * (1 - fee) * (1 - adverse);
}
export function fillState(tape: Trade[], decisionSlot: number, setting: ExecutionSetting, graduationTs: number | null) {
  const slot = decisionSlot + EXECUTION[setting].delay;
  const ts = timeAt(tape, slot);
  if (slot > tape.at(-1)!.slot || (graduationTs != null && ts >= graduationTs)) return null;
  const t = tape[beforeSlot(tape, slot)];
  return t?.state ? { state: t.state, slot, ts } : null;
}
export function costs(setting: ExecutionSetting) {
  const c = EXECUTION[setting];
  return { ...c, adverse: (c.slippageBps + c.mevBps) / 1e4, tx: BASE_TX_FEE + c.priority };
}
