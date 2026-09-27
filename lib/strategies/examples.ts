import { CURVE_K, type TapeEvent } from "./catalog";

/** Deterministic, explicitly synthetic tapes for exercising the rules, never performance evidence. */
export function exampleEvents(): TapeEvent[] {
  const rows: TapeEvent[] = [];
  let id = 0;
  const epoch = 1_790_000_000;
  for (let m = 0; m < 10; m++) {
    let x = 30;
    for (let second = 0; second <= 380; second++) {
      const rising = second < 250 + m;
      const delta = second < 130 ? (second % 2 ? -0.004 : 0.005) :
        rising ? 0.31 + m * 0.009 : -(0.11 + m * 0.03);
      const next = Math.max(30.01, x + delta), sol = Math.abs(next - x);
      const tokens = Math.abs(CURVE_K / x - CURVE_K / next);
      rows.push({ id: ++id, mint: `EXAMPLE-CURVE-${m + 1}`, ts: epoch + second, slot: 10_000 + second * 3,
        kind: next >= x ? "buy" : "sell", side: next >= x ? "buy" : "sell", venue: "curve", pool: null,
        wallet: `example-buyer-${second % (m === 9 ? 1 : 7)}`, sol, tokens, vSol: next, poolClass: "standard" });
      x = next;
    }
  }
  for (let m = 0; m < 8; m++) {
    const mint = `EXAMPLE-AMM-${m + 1}`, pool = `example-pool-${m + 1}`;
    rows.push({ id: ++id, mint, ts: epoch, slot: 10_000, kind: "migrate", side: null, venue: "curve",
      pool: null, wallet: null, sol: null, tokens: null, vSol: null });
    let x = 84.99, y = 206.9e6;
    for (let tick = 0; tick < 1650; tick++) {
      const buy = tick < 55 ? tick % 4 !== 0 : tick % 3 === 0;
      const size = 0.65 + (tick % 5) * 0.04 + m * 0.01;
      let sol: number, tokens: number;
      if (buy) { const dx = size * 0.9975; tokens = y * dx / (x + dx); x += dx; y -= tokens; sol = size; }
      else { tokens = size * y / x; const dx = x * tokens / (y + tokens); x -= dx; y += tokens; sol = dx * 0.9975; }
      rows.push({ id: ++id, mint, ts: epoch + tick * 0.4 + 0.1, slot: 10_001 + tick,
        kind: buy ? "buy" : "sell", side: buy ? "buy" : "sell", venue: "pumpswap", pool,
        wallet: `example-buyer-${tick % 7}`, sol, tokens, vSol: null, poolClass: "standard" });
    }
  }
  return rows;
}
