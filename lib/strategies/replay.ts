import { GRADUATION_PRICE, STRATEGIES, type Episode, type ReplayOptions, type TapeEvent } from "./catalog";
import { LADDER_LEVELS, levelsCrossed } from "../trade/curve-ladder";
import { crossingFeatures, exitFeatures, EXIT_TAU, shouldScaleIn, treeHazard } from "./features";
import { beforeTime, buyAt, costs, fillState, prepareTape, randomFor, sellAt, slotAt, spot, type Trade } from "./pool";
import { summarize, type Observation } from "./statistics";

export type Candidate = { episode: Episode; tape: Trade[]; slot: number; graduationTs: number | null };
const emptyEpisode = (id: string, mint: string, poolClass: string, level: number | null, ts: number): Episode => ({
  id, mint, poolClass, level, decisionTs: ts, fired: false, status: "SKIPPED", reason: "Rule did not fire",
  features: {}, checks: {}, entryTs: null, exitTs: null, addSecond: null, stakeSol: 0,
  pnlSol: null, netReturn: null, incrementalReturn: null, points: [],
});

/** Each opportunity is independent, with no portfolio caps or unrelated signal gates. */
export function candidates(events: TapeEvent[], options: ReplayOptions) {
  const byMint = new Map<string, TapeEvent[]>();
  const excluded: Record<string, number> = { nonSolOrMissingAmounts: 0, outsideCurveRange: 0, afterGraduation: 0, timestampOrder: 0, missingPool: 0 };
  for (const e of [...events].sort((a, b) => a.slot - b.slot || a.id - b.id)) {
    const group = byMint.get(e.mint) ?? [];
    if (group.length && e.ts < group.at(-1)!.ts) { excluded.timestampOrder++; continue; }
    group.push(e); byMint.set(e.mint, group);
  }
  const out: Candidate[] = [];
  for (const [mint, rows] of byMint) {
    const graduation = rows.find((e) => e.kind === "migrate");
    const graduationTs = graduation?.ts ?? null;
    if (options.strategy === "graduation") {
      if (!graduation) continue;
      const first = rows.find((e) => e.venue === "pumpswap" && e.ts >= graduation.ts && e.pool);
      // The frozen rule is measured from AMM pool open, not from the earlier
      // migration event. On mainnet the first pool trade can arrive many seconds
      // after migration; anchoring to migration scored a window before the pool
      // existed and incorrectly froze the episode as DATA_UNAVAILABLE.
      const poolOpenTs = first?.ts ?? graduation.ts;
      if (poolOpenTs + 5 < (options.fromTs ?? -Infinity)) continue;
      const episode = emptyEpisode(`${mint}:graduation`, mint, first?.poolClass ?? "unknown", null, poolOpenTs + 5);
      const tape = prepareTape(rows.filter((e) => e.venue === "pumpswap" && e.pool === first?.pool && e.ts >= graduation.ts), false);
      const visible = tape.filter((t) => t.ts >= poolOpenTs + 1 && t.ts < episode.decisionTs && t.wallet !== options.targetWallet);
      const start = visible[0];
      const distance = start ? Math.log((start.sol / start.tokens) / GRADUATION_PRICE) : null;
      episode.features = { start_distance: distance, local_trade_rate: start ? visible.length / 4 : null };
      episode.checks = { "Start distance ≤ 0.6931": distance == null ? null : distance <= 0.6931, "Trade rate ≥ 0": start ? true : null };
      episode.fired = Object.values(episode.checks).every((v) => v === true);
      if (!start) { episode.status = "DATA_UNAVAILABLE"; episode.reason = "No AMM trades from one identified pool in the +1s to +5s warm-up window"; }
      else episode.reason = episode.fired ? "Graduation entry conditions passed" : "Start price exceeds the frozen threshold";
      out.push({ episode, tape, slot: tape.length ? slotAt(tape, episode.decisionTs) : graduation.slot, graduationTs: null });
      continue;
    }

    const curveRows = rows.filter((e) => {
      if (e.venue !== "curve" || (e.side !== "buy" && e.side !== "sell")) return false;
      if (graduationTs != null && e.ts >= graduationTs) { excluded.afterGraduation++; return false; }
      if (!(e.sol != null && e.sol > 0 && e.tokens != null && e.tokens > 0)) excluded.nonSolOrMissingAmounts++;
      else if (!(e.vSol != null && e.vSol >= 30 && e.vSol <= 115.005)) excluded.outsideCurveRange++;
      return true;
    });
    const tape = prepareTape(curveRows, true);
    // A rung already exceeded when observation begins is never re-armed later.
    const seen = new Set<number>(LADDER_LEVELS.filter((l) => l <= (tape[0]?.state?.x ?? 30) - 30));
    for (let i = 1; i < tape.length; i++) {
      const prev = tape[i - 1], trade = tape[i];
      if (!prev.state || !trade.state) {
        if (trade.state) for (const l of LADDER_LEVELS) if (trade.state.x - 30 >= l) seen.add(l);
        continue;
      }
      for (const level of levelsCrossed(prev.state.x - 30, trade.state.x - 30)) {
        if (seen.has(level)) continue;
        seen.add(level);
        if (trade.ts < (options.fromTs ?? -Infinity)) continue;
        if (trade.poolClass && trade.poolClass !== "standard") continue;
        const episode = emptyEpisode(`${mint}:${level}`, mint, trade.poolClass ?? "unverified-standard", level, trade.ts);
        if (options.strategy === "curveLadder") {
          Object.assign(episode, crossingFeatures(tape, i, options.targetWallet));
          episode.fired = Object.values(episode.checks).every((v) => v === true);
          episode.status = Object.values(episode.checks).includes(null) ? "DATA_UNAVAILABLE" : "SKIPPED";
          episode.reason = episode.fired ? "All three crossing conditions passed" :
            Object.entries(episode.checks).filter(([, v]) => v !== true).map(([k, v]) => `${k}: ${v == null ? "DATA_UNAVAILABLE" : "failed"}`).join("; ");
        } else {
          episode.fired = true; // Baseline entry; the add rule is evaluated after a fill.
          episode.reason = "Baseline entry at first crossing; waiting for an add signal";
        }
        out.push({ episode, tape, slot: trade.slot, graduationTs });
      }
    }
  }
  return { candidates: out, excluded, mints: byMint.size };
}

/** forcedAdd: undefined = rule; null = no add; number = matched control second. */
export function simulate(candidate: Candidate, options: ReplayOptions, forcedAdd?: number | null, keepPoints = true): Episode {
  const { tape, graduationTs } = candidate;
  const ep: Episode = { ...candidate.episode, features: { ...candidate.episode.features }, checks: { ...candidate.episode.checks }, points: [] };
  if (options.strategy === "scaleIn") ep.fired = false;
  const config = STRATEGIES[options.strategy], c = costs(options.setting);
  const draw = (stage: string) => randomFor(`${ep.id}:${stage}`, options.seed)();
  const entry = tape.length ? fillState(tape, candidate.slot, options.setting, graduationTs) : null;
  const unavailable = (status: "DATA_UNAVAILABLE" | "CENSORED", reason: string) => ({ ...ep, status, reason, pnlSol: null, netReturn: null });
  if (!entry) return unavailable("DATA_UNAVAILABLE", "No valid pool state or tape coverage at the delayed entry slot");
  if (draw("buy") < c.failure) return { ...ep, status: "NO_FILL", reason: "Simulated entry transaction failed", pnlSol: -c.tx, netReturn: null };
  let reference = beforeTime(tape, entry.ts);
  while (reference >= 0 && (tape[reference].wallet === options.targetWallet || tape[reference].slot >= entry.slot)) reference--;
  if (!tape[reference]?.state) return unavailable("DATA_UNAVAILABLE", "Entry reference price unavailable before the last non-target trade");
  const entryPrice = spot(tape[reference].state!);
  const buy = buyAt(entry.state, config.size, 0, undefined, c.adverse);
  let tokens = buy.tokens, footprint = buy.intoPool, spent = config.size, fees = c.tx;
  ep.entryTs = entry.ts; ep.stakeSol = spent + fees;
  const deadline = entry.ts + config.hold;
  let exitTs = deadline, exitReason = `${config.hold}s timer`, attemptedAdd = false;
  if (graduationTs != null && graduationTs <= deadline) { exitTs = graduationTs; exitReason = "Graduation"; }
  for (let second = 1; second <= config.hold && entry.ts + second < exitTs; second++) {
    const ts = entry.ts + second;
    if (ts > tape.at(-1)!.ts) break;
    const features = exitFeatures(tape, ts, entry.ts, entryPrice, footprint, options.targetWallet);
    const hazard = features ? treeHazard(features) : null;
    const index = beforeTime(tape, ts), st = tape[index]?.state;
    if (keepPoints && st) ep.points.push({ second, price: spot({ ...st, x: st.x + footprint }), hazard });
    if (options.strategy === "graduation" && hazard != null && hazard >= EXIT_TAU) {
      exitTs = ts; exitReason = `Exit tree ≥ ${EXIT_TAU.toFixed(6)}`; break;
    }
    if (options.strategy !== "scaleIn" || attemptedAdd || forcedAdd === null) continue;
    const wantsAdd = forcedAdd === undefined ? shouldScaleIn(features) : second === forcedAdd;
    if (!wantsAdd) continue;
    attemptedAdd = true; ep.addSecond = second; ep.fired = true;
    ep.features = { ret_since_entry: features?.ret_since_entry ?? null, secs_since_last_trade: features?.secs_since_last_trade ?? null };
    ep.checks = { "Return > 0": (features?.ret_since_entry ?? -Infinity) > 0, "Last trade < 3s": (features?.secs_since_last_trade ?? Infinity) < 3 };
    const add = fillState(tape, slotAt(tape, ts), options.setting, graduationTs);
    if (!add || add.ts >= exitTs) return unavailable("CENSORED", "Add triggered but could not be priced before the exit");
    fees += c.tx;
    if (draw(`add:${second}`) < c.failure) continue;
    const fill = buyAt(add.state, config.size, footprint, undefined, c.adverse);
    tokens += fill.tokens; footprint += fill.intoPool; spent += config.size;
    ep.stakeSol = spent + fees;
  }
  if (options.strategy === "scaleIn" && forcedAdd !== null) ep.fired = ep.addSecond != null;
  // At graduation the recorded curve closes. Do not sell against a fabricated AMM reserve.
  if (graduationTs != null && exitTs >= graduationTs) return unavailable("CENSORED", "Graduation triggered exit; a curve fill after migration is unavailable");
  if (exitTs > tape.at(-1)!.ts) return unavailable("CENSORED", "Tape ends before the position's exit");
  let decisionSlot = slotAt(tape, exitTs);
  for (let attempt = 0; attempt < 20; attempt++) {
    const sell = fillState(tape, decisionSlot, options.setting, graduationTs);
    if (!sell) return unavailable("CENSORED", "No valid pool state or tape coverage at the delayed exit slot");
    fees += c.tx;
    if (draw(`sell:${attempt}`) < c.failure) { decisionSlot = sell.slot; continue; }
    const received = sellAt(sell.state, tokens, footprint, undefined, c.adverse);
    ep.status = "CLOSED"; ep.pnlSol = received - spent - fees; ep.netReturn = ep.pnlSol / spent;
    ep.exitTs = sell.ts; ep.stakeSol = spent + c.tx;
    ep.reason = options.strategy === "scaleIn" ? `${ep.addSecond == null ? "No add signal" : `Add signal at second ${ep.addSecond}`}; ${exitReason}` : exitReason;
    if (keepPoints) {
      ep.points.unshift({ second: 0, price: entryPrice, hazard: null });
      ep.points.push({ second: sell.ts - entry.ts, price: spot({ ...sell.state, x: sell.state.x + footprint }), hazard: null });
    }
    return ep;
  }
  return unavailable("CENSORED", "Exit still failed after 20 simulated attempts");
}

export function runReplay(events: TapeEvent[], options: ReplayOptions) {
  const found = candidates(events, options);
  const episodes: Episode[] = [], observations: Observation[] = [];
  const scaleCandidates: Array<{ candidate: Candidate; baseline: Episode; actual: Episode }> = [];
  for (const candidate of found.candidates) {
    const original = candidate.episode;
    if (options.strategy === "scaleIn") {
      const actual = simulate(candidate, options), baseline = simulate(candidate, options, null, false);
      if (actual.pnlSol != null && baseline.pnlSol != null && actual.status === "CLOSED" && baseline.status === "CLOSED") {
        actual.incrementalReturn = (actual.pnlSol - baseline.pnlSol) / STRATEGIES.scaleIn.size;
      }
      episodes.push(actual); scaleCandidates.push({ candidate, baseline, actual });
    } else {
      const simulated = simulate(candidate, options, null, original.fired);
      episodes.push(original.fired ? simulated : original);
      if (simulated.status === "CLOSED" && simulated.netReturn != null) observations.push({
        mint: original.mint, group: `${original.poolClass}:${original.level ?? "graduation"}`, value: simulated.netReturn, selected: original.fired,
      });
    }
  }
  if (options.strategy === "scaleIn") {
    const seconds = new Set(scaleCandidates.flatMap(({ actual }) => actual.addSecond == null ? [] : [actual.addSecond]));
    for (const { candidate, baseline, actual } of scaleCandidates) {
      if (baseline.status !== "CLOSED" || baseline.pnlSol == null) continue;
      for (const second of seconds) {
        const control = actual.addSecond === second ? actual : simulate(candidate, options, second, false);
        if (control.status !== "CLOSED" || control.pnlSol == null || control.addSecond !== second) continue;
        observations.push({ mint: actual.mint, group: `${actual.poolClass}:${actual.level}:${second}`,
          value: (control.pnlSol - baseline.pnlSol) / STRATEGIES.scaleIn.size, selected: actual.addSecond === second });
      }
    }
  }
  const summary = summarize(observations, options.seed ?? 1701);
  const counts = { opportunities: episodes.length, fired: episodes.filter((e) => e.fired).length,
    closed: episodes.filter((e) => e.fired && e.status === "CLOSED").length,
    censored: episodes.filter((e) => e.status === "CENSORED").length,
    unavailable: episodes.filter((e) => e.status === "DATA_UNAVAILABLE").length,
    noFill: episodes.filter((e) => e.status === "NO_FILL").length };
  const byLevel = LADDER_LEVELS.map((level) => {
    const rows = episodes.filter((e) => e.level === level), closed = rows.filter((e) => e.fired && e.netReturn != null);
    return { level, opportunities: rows.length, fired: rows.filter((e) => e.fired).length,
      mean: closed.length ? closed.reduce((s, e) => s + e.netReturn!, 0) / closed.length : null };
  });
  const selected = episodes.filter((e) => e.fired && e.status === "CLOSED").sort((a, b) => a.decisionTs - b.decisionTs);
  let cumulative = 0;
  const equity = selected.map((e, i) => ({ trade: i + 1, pnl: cumulative += e.pnlSol ?? 0 }));
  return { strategy: options.strategy, setting: options.setting, counts, summary, byLevel, equity,
    excluded: found.excluded, mints: found.mints,
    // Prefer actual signals in the inspector; expose total and cap explicitly.
    episodes: [...episodes].sort((a, b) => Number(b.fired) - Number(a.fired) || b.decisionTs - a.decisionTs).slice(0, 200),
    displayedEpisodes: Math.min(200, episodes.length), totalEpisodes: episodes.length,
  };
}
export type ReplayResult = ReturnType<typeof runReplay>;
