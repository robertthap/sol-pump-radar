import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { readState } from "@/lib/circuit-breaker/state";
import {
  paperResearchBuy,
  paperResearchCensor,
  paperResearchClose,
  paperResearchFailureFee,
} from "@/lib/paper/engine";
import { updateStats, type AutoSessionDto } from "@/lib/db/repos/auto-sessions";
import { episodeStatuses, finishResearchEpisode, markResearchPosition, recordResearchEpisode, researchLiveEvents, researchPositions, type ResearchPosition } from "@/lib/db/repos/research-bot";
import { CURVE_K, STRATEGIES, type ExecutionSetting, type TapeEvent } from "@/lib/strategies/catalog";
import { researchStrategy } from "@/lib/strategies/bot-config";
import { candidates } from "@/lib/strategies/replay";
import { beforeTime, buyAt, costs, fillState, prepareTape, randomFor, sellAt, slotAt, spot } from "@/lib/strategies/pool";
import { EXIT_TAU, exitFeatures, shouldScaleIn, treeHazard } from "@/lib/strategies/features";
import { tradingFeeSol } from "@spr/trading";

const finite = (v: unknown, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const proxy = (s: { x: number; k: number }) => Math.sqrt(spot(s) * CURVE_K);
const permitBuys = async () => (await readState()).state !== "HALTED";
/**
 * M03: the research engine's trading fee comes from the SHARED model rather than
 * a hardcoded 0.0125. The general executor charged 1.00% while this charged
 * 1.25%, both into the same paper_positions ledger, so the two engines' results
 * were never comparable. Both are 1.25% now, with one place to change it.
 */
const researchTradingFee = (notionalSol: number) =>
  tradingFeeSol(notionalSol, { venue: "curve", priorityFeeSol: 0, enabled: true });

/** Research sessions consume the event tape directly; generic signals/presets never gate these rules. */
export async function tickResearchTrader(session: AutoSessionDto | null, allowEntries: boolean) {
  const open = await researchPositions();
  const strategy = researchStrategy(session?.params.researchStrategy);
  const enabled = !!session && session.mode === "paper" && !!strategy && allowEntries;
  if (!open.length && !enabled) return;
  const events = await researchLiveEvents(open.map((p) => p.mint), enabled);
  const byMint = new Map<string, TapeEvent[]>();
  for (const event of events) { const rows = byMint.get(event.mint) ?? []; rows.push(event); byMint.set(event.mint, rows); }
  for (const position of open) await managePosition(position, byMint.get(position.mint) ?? [], enabled ? session : null);
  if (!enabled || !session || !strategy) return;
  const now = Date.now() / 1000;
  const started = Date.parse(session.startedAt) / 1000;
  const found = candidates(events, { strategy, setting: session.params.researchExecution ?? "BASE", fromTs: Math.max(started, now - 20), targetWallet: session.params.researchTargetWallet });
  const known = await episodeStatuses(session.id);
  let opened = 0;
  const skips: Array<{ts:string;mint:string;reason:string}> = [];
  for (const candidate of found.candidates) {
    const e = candidate.episode;
    if (known.has(e.id) && known.get(e.id) !== "PENDING") continue;
    // The strategy's decision time is the only entry wait. If the tape is still
    // catching up, retry the episode instead of freezing DATA_UNAVAILABLE early.
    if (now < e.decisionTs) continue;
    if (!e.fired && e.status === "DATA_UNAVAILABLE" && now - e.decisionTs <= 15) continue;
    const accepted = e.fired;
    const status = accepted ? "PENDING" : e.status;
    const rule = strategy === "scaleIn" ? "Curve Ladder baseline entry; Winner Scale-In manages the add" : e.reason;
    // Scale-In starts from Curve Ladder entries in the BOT (unlike the lab's all-crossing benchmark).
    // This keeps its entry universe explicit and identical to the Curve Ladder bot for comparison.
    if (strategy === "scaleIn") {
      const ladder = candidates(events.filter((r) => r.mint === e.mint), { strategy: "curveLadder", setting: session.params.researchExecution ?? "BASE", fromTs: e.decisionTs, targetWallet: session.params.researchTargetWallet }).candidates.find((c) => c.episode.id === e.id);
      if (!ladder?.episode.fired) {
        await recordResearchEpisode(session.id, e, strategy, ladder?.episode.status ?? "SKIPPED", `Baseline: ${ladder?.episode.reason ?? "no qualified curve entry"}`);
        continue;
      }
      e.features = ladder.episode.features;
    }
    await recordResearchEpisode(session.id, e, strategy, status, rule);
    if (!accepted) continue;
    const finish = async (outcome: string, reason: string) => {
      await finishResearchEpisode(session.id, e.id, outcome, reason);
      if (outcome !== "OPEN") skips.push({ ts: new Date().toISOString(), mint: e.mint, reason });
    };
    if (now - e.decisionTs > 15 || now < e.decisionTs) { await finish("MISSED", "Decision is over 15s old; stale data never opens a live paper position"); continue; }
    const setting = session.params.researchExecution ?? "BASE", c = costs(setting);
    const entry = fillState(candidate.tape, candidate.slot, setting, candidate.graduationTs);
    if (!entry) continue; // Pending while the configured fill slot has not yet arrived in the tape.
    if (randomFor(`${session.id}:${e.id}:buy`)() < c.failure) {
      await paperResearchFailureFee({ sessionId: session.id, key: e.id, fee: c.tx });
      await finish("NO_FILL", `Simulated entry transaction failed; ${c.tx} SOL transaction fee`); continue;
    }
    let ref = beforeTime(candidate.tape, entry.ts);
    while (ref >= 0 && (candidate.tape[ref].wallet === session.params.researchTargetWallet || candidate.tape[ref].slot >= entry.slot)) ref--;
    const reference = candidate.tape[ref]?.state;
    if (!reference) { await finish("DATA_UNAVAILABLE", "No point-in-time entry reference"); continue; }
    if (!(await permitBuys())) return;
    const fill = buyAt(entry.state, STRATEGIES[strategy].size, 0, undefined, c.adverse);
    const key = `research:${session.id}:${createHash("sha256").update(e.id).digest("hex").slice(0,32)}`;
    const features = {
      auto: true, ui_mode: "demo", session_id: session.id, research_strategy: strategy, strategy_name: STRATEGIES[strategy].name,
      research_execution: setting, research_episode: e.id, research_pool: candidate.tape[0]?.pool ?? null,
      research_venue: strategy === "graduation" ? "pumpswap" : "curve", research_entry_ts: entry.ts,
      research_entry_price: spot(reference), research_footprint: fill.intoPool, research_k: entry.state.k,
      research_last_second: 0, research_added: false, research_add_attempted: false, research_status: "OPEN",
      research_target_wallet: session.params.researchTargetWallet ?? null, research_tx_fees: c.tx,
      research_entry_reason: rule, research_features: e.features, research_level: e.level,
      research_mark_pnl: null, price_at_ms: 0,
    };
    const result = await paperResearchBuy({ mint: e.mint, key, autoSessionId: session.id, maxConcurrent: session.params.maxConcurrent,
      dailyLossCap: session.params.maxDailyLossSol, fill: { price: proxy(entry.state), tokens: fill.tokens, cash: STRATEGIES[strategy].size + c.tx,
        fee: researchTradingFee(STRATEGIES[strategy].size) + c.tx, ts: entry.ts }, features });
    await finish(result.ok ? "OPEN" : "SKIPPED", result.ok ? `${STRATEGIES[strategy].name}: ${rule}` : result.reason);
    if (result.ok && !result.duplicate) opened++;
  }
  // Pending decisions which never obtained data expire explicitly, rather than lingering forever.
  await getDb().execute(sql`UPDATE research_episodes SET status='DATA_UNAVAILABLE',reason='No pool state arrived for the entry fill within 15 seconds',updated_at=now()
    WHERE session_id=${session.id}::bigint AND status='PENDING' AND decision_ts < now()-interval '15 seconds'`);
  const latest = events.reduce((last, e) => Math.max(last, e.ts), 0);
  const statusMessage = latest < now - 15 ? "DATA_UNAVAILABLE: no fresh event feed; waiting for new trades" :
    strategy === "graduation" && !events.some((e) => e.venue === "pumpswap") ? "DATA_UNAVAILABLE: waiting for graduation and AMM trades" :
      `${STRATEGIES[strategy].name}: monitoring first opportunities; ${found.candidates.length} recent episodes`;
  await updateStats(BigInt(session.id), { lastTickAt: new Date().toISOString(), lastOpenedCount: opened,
    lastPendingCount: found.candidates.filter((c) => c.episode.fired).length, lastSkipReasons: [statusMessage],
    recentFilterSkips: [...skips, ...(session.stats.recentFilterSkips ?? [])].slice(0,40) });
}

async function managePosition(p: ResearchPosition, rows: TapeEvent[], active: AutoSessionDto | null) {
  const f = { ...p.features }, strategy = researchStrategy(f.research_strategy);
  if (!strategy) return;
  if (f.research_status === "CENSORED") {
    await paperResearchCensor({
      id: p.id,
      reason: String(f.research_reason ?? "CENSORED: outcome unavailable"),
      ts: Date.now() / 1000,
    });
    return;
  }
  const setting = (f.research_execution ?? "BASE") as ExecutionSetting, c = costs(setting);
  const entryTs = finite(f.research_entry_ts), deadline = entryTs + STRATEGIES[strategy].hold;
  const graduation = rows.find((e) => e.kind === "migrate" && e.ts >= entryTs)?.ts ?? null;
  const tape = prepareTape(rows.filter((e) => e.side && e.venue === f.research_venue &&
    (f.research_venue !== "pumpswap" || e.pool === f.research_pool) &&
    (f.research_venue !== "curve" || graduation == null || e.ts < graduation)), f.research_venue === "curve");
  const now = Date.now() / 1000;
  const censor = async (reason: string) => {
    f.research_status = "CENSORED"; f.research_reason = reason;
    const closed = await paperResearchCensor({ id: p.id, reason, ts: Date.now() / 1000 });
    if (closed.ok) {
      await finishResearchEpisode(String(f.session_id), String(f.research_episode), "CENSORED", reason);
    }
  };
  if (!tape.length) { if (now >= deadline) await censor("CENSORED: no tape available for exit"); return; }
  let tokens = p.quantity, notional = p.notional, footprint = finite(f.research_footprint);
  let exitAt = f.research_exit_ts == null ? Math.min(deadline, graduation ?? Infinity) : finite(f.research_exit_ts);
  let exitReason = String(f.research_exit_reason ?? (graduation != null && graduation <= deadline ? "graduation" : "research_timer"));
  const currentSecond = Math.min(STRATEGIES[strategy].hold, Math.floor(Math.min(now, tape.at(-1)!.ts) - entryTs));
  for (let second = finite(f.research_last_second) + 1; second <= currentSecond && entryTs + second < exitAt; second++) {
    const ts = entryTs + second;
    const values = exitFeatures(tape, ts, entryTs, finite(f.research_entry_price), footprint, typeof f.research_target_wallet === "string" ? f.research_target_wallet : undefined);
    f.research_last_second = second;
    if (strategy === "graduation" && values) {
      const hazard = treeHazard(values); f.research_hazard = hazard;
      if (hazard != null && hazard >= EXIT_TAU) { exitAt = ts; exitReason = "research_exit_tree"; break; }
    }
    if (strategy === "scaleIn" && f.research_add_attempted !== true && f.research_pending_add == null && shouldScaleIn(values) && active?.id === String(f.session_id)) {
      f.research_pending_add = ts;
      f.research_add_reason = `Winner with recent trade at hold second ${second}`;
    }
  }
  if (f.research_pending_add != null && f.research_add_attempted !== true && active?.id === String(f.session_id)) {
    const addTs = finite(f.research_pending_add), add = fillState(tape, slotAt(tape, addTs), setting, graduation);
    if (add && add.ts < exitAt && await permitBuys()) {
      const fill = buyAt(add.state, STRATEGIES.scaleIn.size, footprint, undefined, c.adverse);
      f.research_add_attempted = true;
      if (randomFor(`${p.id}:add`)() >= c.failure) {
        const next = { ...f, research_footprint: footprint + fill.intoPool, research_added: true, research_tx_fees: finite(f.research_tx_fees) + c.tx };
        const result = await paperResearchBuy({ mint: p.mint, key: `research:add:${p.id}`, autoSessionId: active.id, addTo: p.id,
          maxConcurrent: active.params.maxConcurrent, dailyLossCap: active.params.maxDailyLossSol, features: next,
          fill: { price: proxy(add.state), tokens: fill.tokens, cash: STRATEGIES.scaleIn.size + c.tx, fee: researchTradingFee(STRATEGIES.scaleIn.size) + c.tx, ts: add.ts } });
        if (result.ok && !result.duplicate) { tokens += fill.tokens; notional += STRATEGIES.scaleIn.size + c.tx; footprint += fill.intoPool; Object.assign(f,next); f.research_add_ts = add.ts; }
        else if (!result.ok) f.research_add_reason = result.reason;
      } else {
        await paperResearchFailureFee({ sessionId: active.id, key: String(f.research_episode), positionId: p.id, fee: c.tx });
        notional += c.tx;
        f.research_add_reason = "Simulated add transaction failed; transaction fee charged";
      }
    } else if (now >= exitAt) f.research_add_attempted = true;
  }
  f.research_exit_ts = exitAt; f.research_exit_reason = exitReason;
  if (graduation != null && now >= graduation && graduation <= exitAt) { await censor("CENSORED: graduated before a curve exit could fill"); return; }
  if (now >= exitAt) {
    const slot = finite(f.research_exit_slot, slotAt(tape, exitAt));
    let attempts = finite(f.research_sell_attempts);
    const sell = fillState(tape, slot, setting, graduation);
    if (sell) {
      attempts++; f.research_sell_attempts = attempts;
      if (randomFor(`${p.id}:sell:${attempts}`)() < c.failure) {
        f.research_exit_slot = sell.slot;
        f.research_failed_sell_fees = finite(f.research_failed_sell_fees) + c.tx;
      } else {
        const grossNet = sellAt(sell.state, tokens, footprint, undefined, c.adverse);
        const proceeds = Math.max(0, grossNet - c.tx - finite(f.research_failed_sell_fees));
        const closed = await paperResearchClose({ id: p.id, price: proxy(sell.state), proceeds, fee: c.tx + finite(f.research_failed_sell_fees), reason: exitReason, ts: sell.ts });
        if (closed.ok) await finishResearchEpisode(String(f.session_id), String(f.research_episode), "CLOSED", `${STRATEGIES[strategy].name}: ${exitReason}; P&L ${closed.pnl.toFixed(6)} SOL`);
        return;
      }
    }
    if (now - exitAt > 15 || attempts >= 20) { await censor("CENSORED: delayed exit could not be priced from fresh tape"); return; }
  }
  const last = tape[beforeTime(tape, now + 0.001)];
  const fresh = last?.state && now - last.ts <= 15;
  const markExitFee = c.tx + finite(f.research_failed_sell_fees);
  f.research_mark_exit_fee = markExitFee;
  const pnl = fresh
    ? Math.max(0, sellAt(last.state!, tokens, footprint, undefined, c.adverse) - markExitFee) - notional
    : null;
  await markResearchPosition(p.id, f, fresh ? proxy(last.state!) : null, pnl);
}
