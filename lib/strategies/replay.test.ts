import assert from "node:assert/strict";
import test from "node:test";
import { CURVE_K, type TapeEvent } from "./catalog";
import { exampleEvents } from "./examples";
import { crossingFeatures, exitFeatures, EXIT_TAU, shouldScaleIn, treeHazard } from "./features";
import { ammPairK, buyAt, fillState, prepareTape, sellAt } from "./pool";
import { candidates, runReplay } from "./replay";
import { summarize } from "./statistics";

const examples = exampleEvents();
const curve = examples.filter((e) => e.mint === "EXAMPLE-CURVE-1");
const tape = prepareTape(curve, true);
const options = { strategy: "curveLadder" as const, setting: "BASE" as const };

test("costless constant-product round trip is zero with the position footprint", () => {
  const state = { x: 55, k: CURVE_K }, amount = 0.349;
  const buy = buyAt(state, amount, 0, 0, 0);
  assert.ok(Math.abs(sellAt(state, buy.tokens, buy.intoPool, 0, 0) - amount) < 1e-14);
  assert.ok(sellAt(state, buy.tokens, 0, 0, 0) < amount);
});

test("fees remain outside the invariant", () => {
  const state = { x: 60, k: CURVE_K }, buy = buyAt(state, 0.349);
  assert.ok(Math.abs(buy.intoPool - 0.349 * 0.9875) < 1e-14);
  assert.ok(Math.abs(sellAt(state, buy.tokens, buy.intoPool) - 0.349 * 0.9875 ** 2) < 1e-14);
});

test("AMM invariant is reconstructed from consecutive trades at 0.25%", () => {
  const amm = examples.filter((e) => e.mint === "EXAMPLE-AMM-1" && e.side);
  const k = ammPairK(amm[2], amm[3]);
  assert.ok(k != null && Math.abs(k / (84.99 * 206.9e6) - 1) < 1e-7);
  const prepared = prepareTape(amm, false);
  assert.equal(prepared[2].state, null);
  assert.ok(prepared[3].state);
});

test("fill reads only trades earlier than decision slot plus frozen delay", () => {
  const decision = tape[200].slot, fill = fillState(tape, decision, "BASE", null)!;
  assert.equal(fill.slot, decision + 3);
  assert.equal(fill.state.x, tape[200].state!.x);
  const optimistic = fillState(tape, decision, "OPTIMISTIC", null)!;
  assert.equal(optimistic.slot, decision + 1);
});

test("same-second and target-wallet trades are excluded from crossing flow", () => {
  const rows = curve.map((e) => ({ ...e }));
  rows[199].ts = rows[200].ts;
  rows[198].wallet = "target";
  const a = crossingFeatures(prepareTape(rows, true), 200, "target");
  rows[199].sol = 9000; rows[198].sol = 9000;
  const b = crossingFeatures(prepareTape(rows, true), 200, "target");
  assert.deepEqual(a, b);
});

test("missing history is DATA_UNAVAILABLE, never concentration or progress zero", () => {
  const result = crossingFeatures(tape.slice(200, 205), 1);
  assert.equal(result.features.curve_progress_rate_120s, null);
  assert.equal(result.checks["Progress > 0.00256623/s"], null);
});

test("live curve entries receive the full frozen 120-second history window", () => {
  const crossingTs = 1_790_000_226;
  const short = curve.filter((e) => e.ts >= crossingTs - 30 && e.ts <= crossingTs + 10);
  const complete = curve.filter((e) => e.ts >= crossingTs - 150 && e.ts <= crossingTs + 10);
  const shortLadder = candidates(short, { ...options, fromTs: crossingTs - 5 }).candidates
    .find((c) => c.episode.level === 30)!;
  const fullLadder = candidates(complete, { ...options, fromTs: crossingTs - 5 }).candidates
    .find((c) => c.episode.level === 30)!;
  const scaleBaseline = candidates(complete, { ...options, strategy: "scaleIn", fromTs: crossingTs - 5 }).candidates
    .find((c) => c.episode.level === 30)!;
  assert.equal(shortLadder.episode.status, "DATA_UNAVAILABLE");
  assert.equal(fullLadder.episode.fired, true);
  assert.equal(scaleBaseline.episode.fired, true);
});

test("exit clock uses all 13 features and never includes trades at t", () => {
  const at = tape[220].ts, entryTs = tape[210].ts, entryPrice = tape[209].state!.x ** 2 / CURVE_K;
  const before = exitFeatures(tape, at, entryTs, entryPrice, 0, "target")!;
  const copy = tape.map((t) => ({ ...t })); copy[220] = { ...copy[220], sol: 9999, state: { x: 100, k: CURVE_K } };
  assert.deepEqual(exitFeatures(copy, at, entryTs, entryPrice, 0, "target"), before);
  assert.equal(Object.keys(before).length, 14); // 13 features + duration bucket
});

test("frozen exit leaf meets full-precision tau; missing tree inputs are unknown", () => {
  const f = { duration_bucket: 1, ret_since_entry: 0.04, drawdown_from_peak: 0 };
  assert.equal(treeHazard(f), EXIT_TAU);
  assert.equal(treeHazard({ ...f, ret_since_entry: null }), null);
});

test("scale-in uses strict positive return and strictly less than 3 seconds", () => {
  assert.equal(shouldScaleIn({ ret_since_entry: 0, secs_since_last_trade: 1 }), false);
  assert.equal(shouldScaleIn({ ret_since_entry: 0.1, secs_since_last_trade: 3 }), false);
  assert.equal(shouldScaleIn({ ret_since_entry: 0.001, secs_since_last_trade: 2.99 }), true);
  assert.equal(shouldScaleIn(null), false);
});

test("each rung produces one episode even after a drop and recross", () => {
  const rows = curve.map((r) => ({ ...r }));
  for (let i = 300; i < 310; i++) rows[i].vSol = i % 2 ? 62 : 58;
  const result = runReplay(rows, options);
  assert.equal(new Set(result.episodes.map((e) => e.id)).size, result.totalEpisodes);
  assert.equal(result.episodes.filter((e) => e.level === 30).length, 1);
});

test("truncated history does not re-arm an already exceeded rung", () => {
  const rows = curve.slice(240).map((r) => ({ ...r }));
  rows[4].vSol = 58; rows[5].vSol = 62;
  const result = runReplay(rows, options);
  assert.equal(result.episodes.some((e) => e.level === 30), false);
});

test("curve example produces real signals with the frozen size and 31s timer", () => {
  const result = runReplay(curve, options);
  const closed = result.episodes.find((e) => e.fired && e.status === "CLOSED")!;
  assert.ok(closed);
  assert.ok(Math.abs(closed.stakeSol - (0.349 + 0.000055)) < 1e-12);
  assert.ok(closed.exitTs! - closed.entryTs! >= 31);
  assert.ok(result.episodes.filter((e) => e.fired).every((e) => e.level! >= 30));
});

test("scale-in adds at most one equal tranche without resetting the hold", () => {
  const result = runReplay(curve, { ...options, strategy: "scaleIn" });
  const closed = result.episodes.find((e) => e.addSecond != null && e.status === "CLOSED" && e.stakeSol > 0.6)!;
  assert.ok(closed);
  assert.ok(closed.addSecond! >= 1);
  assert.ok(closed.stakeSol < 0.7);
  assert.ok(closed.exitTs! - closed.entryTs! < 34);
  assert.notEqual(closed.incrementalReturn, null);
});

test("filled positions missing the exit remain CENSORED", () => {
  const result = runReplay(curve.slice(0, 235), options);
  const censored = result.episodes.find((e) => e.status === "CENSORED");
  assert.ok(censored);
  assert.equal(censored.pnlSol, null); assert.equal(censored.netReturn, null);
});

test("graduation censors curve fills and excludes later curve-labelled events", () => {
  const migration: TapeEvent = { ...curve[230], id: 99999, kind: "migrate", side: null };
  const result = runReplay([...curve, migration], options);
  assert.ok(result.excluded.afterGraduation > 0);
  assert.equal(result.episodes.some((e) => e.exitTs != null && e.exitTs >= migration.ts), false);
});

test("zero SOL rows are counted and do not silently bridge an unknown pool state", () => {
  const rows = curve.map((r) => ({ ...r })); rows[200].sol = 0;
  const result = runReplay(rows, options);
  assert.equal(result.excluded.nonSolOrMissingAmounts, runReplay(curve, options).excluded.nonSolOrMissingAmounts + 1);
  const prepared = prepareTape(rows, true);
  assert.equal(prepared[200].state, null);
  assert.equal(fillState(prepared, rows[200].slot, "OPTIMISTIC", null), null);
});

test("V1 uses the frozen exit tree and no pool-class eligibility filter", () => {
  const rows = examples.filter((e) => e.mint === "EXAMPLE-AMM-1").map((e) => ({ ...e, poolClass: "alternative" }));
  const result = runReplay(rows, { strategy: "graduation", setting: "BASE", seed: 1702 });
  assert.equal(result.counts.opportunities, 1);
  assert.equal(result.episodes[0].fired, true);
  assert.equal(result.episodes[0].status, "CLOSED");
  assert.match(result.episodes[0].reason, /Exit tree/);
  assert.ok(result.episodes[0].exitTs! - result.episodes[0].entryTs! < 600);
});

test("V1 anchors its decision window to AMM pool open, not migration", () => {
  const delay = 12;
  const rows = examples.filter((e) => e.mint === "EXAMPLE-AMM-1").map((e) => ({
    ...e,
    ts: e.venue === "pumpswap" ? e.ts + delay : e.ts,
  }));
  const first = rows.find((e) => e.venue === "pumpswap")!;
  const found = candidates(rows, { strategy: "graduation", setting: "BASE" }).candidates[0];
  assert.equal(found.episode.decisionTs, first.ts + 5);
  assert.equal(found.episode.fired, true);
});

test("V1 cannot manufacture a return when AMM data is missing", () => {
  const migration: TapeEvent = { ...curve[0], kind: "migrate", side: null };
  const result = runReplay([migration], { strategy: "graduation", setting: "BASE" });
  assert.equal(result.episodes[0].status, "DATA_UNAVAILABLE");
  assert.equal(result.summary.selectedMean, null);
});

test("controls match crossing level and exclude the selected mint", () => {
  const s = summarize([
    { mint: "a", group: "standard:30", selected: true, value: 0.1 },
    { mint: "b", group: "standard:30", selected: false, value: 0.02 },
    { mint: "c", group: "standard:5", selected: false, value: 99 },
  ], 1701);
  assert.equal(s.draws, 1000);
  assert.ok(Math.abs(s.excess! - 0.08) < 1e-12);
  assert.equal(s.bootstrapInterval, null); // One selected mint is not an interval.
  assert.equal(s.unmatched, 0);
});

test("same tape and settings produce identical outcomes", () => {
  assert.deepEqual(runReplay(curve, options), runReplay(curve, options));
});
