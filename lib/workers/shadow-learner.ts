import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { env } from "@/lib/env";
import { readState } from "@/lib/circuit-breaker/state";
import { getDb } from "@/lib/db/client";
import { paperOpen, paperClose, loadOpenPositions } from "@/lib/paper/engine";
import { recordOutcome } from "@/lib/db/repos/outcomes";
import { fetchMintFlags } from "@/lib/db/repos/bots";
import { fetchRugLabel } from "@/lib/db/repos/rug-labels";
import { analyzeMintInsiders } from "@/lib/intel/insider-tracker";
import { qualifyEntry } from "@/lib/trade/entry-filter";

const log = logger("shadow-learner");

const TICK_MS = 3_000;
const TP_PCT = 0.4;
const SL_PCT = 0.15;
const MAX_HOLD_MS = 30 * 60_000;

type ShadowOpenRow = {
  id: bigint;
  mint: string;
  sizeSol: number;
  entryVSol: number | null;
  openedAt: Date;
  modulesAtEntry: Record<string, number> | null;
  action: string | null;
};

type ShadowPendingDecision = {
  id: bigint;
  mint: string;
  action: string;
  confluenceScore: number;
  moduleScores: Record<string, number>;
  ts: string;
};

async function latestVSolFor(mint: string): Promise<number | null> {
  const res = await getDb().execute(sql`
    SELECT v_sol_after::float8 AS v FROM events
    WHERE mint = ${mint} AND v_sol_after IS NOT NULL
    ORDER BY ts DESC LIMIT 1
  `);
  return (res as unknown as { rows: Array<{ v: number | null }> }).rows[0]?.v ?? null;
}

async function fetchMintFlow(mint: string) {
  const res = await getDb().execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'buy' AND ts > now() - interval '5 minutes')::int AS buys_5m,
      COUNT(*) FILTER (WHERE kind = 'sell' AND ts > now() - interval '5 minutes')::int AS sells_5m,
      COUNT(DISTINCT wallet) FILTER (WHERE kind = 'buy' AND ts > now() - interval '5 minutes')::int AS unique_buyers_5m
    FROM events
    WHERE mint = ${mint} AND ts > now() - interval '15 minutes'
  `);
  const r = (res as unknown as { rows: Array<{ buys_5m: number; sells_5m: number; unique_buyers_5m: number }> }).rows[0];
  return {
    buys5m: r?.buys_5m ?? 0,
    sells5m: r?.sells_5m ?? 0,
    uniqueBuyers5m: r?.unique_buyers_5m ?? 0,
    buyVol5m: null,
    sellVol5m: null,
    curveVelocity5m: null,
  };
}

/** Open shadow positions via @spr/trading loadOpenPositions (paper_positions truth). */
async function fetchOpenShadowPositions(): Promise<ShadowOpenRow[]> {
  const open = await loadOpenPositions();
  return open
    .filter((p) => p.state === "OPEN")
    .filter((p) => {
      const ef = p.entryFeatures as Record<string, unknown> | null;
      return ef?.purpose === "shadow_learn";
    })
    .map((p) => ({
      id: p.id,
      mint: p.mint,
      sizeSol: p.notionalSol,
      entryVSol: p.entryPrice,
      openedAt: p.openedAt,
      modulesAtEntry: (p.modulesAtEntry as Record<string, number> | null) ?? null,
      action: (p.entryFeatures as { action?: string } | null)?.action ?? null,
    }));
}

/** Decisions not yet mirrored by a shadow paper_positions row. */
async function fetchDecisionsNeedingShadow(
  maxAgeSeconds = 120,
): Promise<ShadowPendingDecision[]> {
  const sec = Math.max(1, Math.floor(maxAgeSeconds));
  const res = await getDb().execute(sql`
    SELECT d.id, d.mint::text AS mint, d.action::text AS action, d.ts,
           d.confluence_score::float8 AS confluence_score, d.module_scores
    FROM decision_log d
    WHERE d.action IN ('BUY_STRONG', 'BUY_MODERATE')
      AND d.ts > now() - (${sec}::text || ' seconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM paper_positions p
        WHERE p.decision_id = d.id
          AND p.entry_features->>'purpose' = 'shadow_learn'
      )
    ORDER BY d.ts ASC
    LIMIT 30
  `);
  type Raw = {
    id: bigint | string | number;
    mint: string;
    action: string;
    ts: Date | string;
    confluence_score: number;
    module_scores: Record<string, number> | null;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    id: typeof r.id === "bigint" ? r.id : BigInt(r.id),
    mint: r.mint,
    action: r.action,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    confluenceScore: r.confluence_score,
    moduleScores: r.module_scores ?? {},
  }));
}

/**
 * Background paper learner — default off (SHADOW_LEARNER=off).
 * All writes: paperOpen / paperClose → @spr/trading executor.
 * Reads: loadOpenPositions + decision_log (no paper-trades repo).
 */
export async function startShadowLearner() {
  const e = env();
  if (e.SHADOW_LEARNER !== "on") {
    log.info("shadow-learner disabled");
    return () => undefined;
  }
  const sizeSol = e.SHADOW_LEARN_SIZE_SOL;
  log.info("shadow-learner starting", { tickMs: TICK_MS, sizeSol, executor: "@spr/trading" });

  async function handleExits() {
    const open = await fetchOpenShadowPositions();
    for (const pos of open) {
      if (pos.entryVSol == null) continue;
      const current = await latestVSolFor(pos.mint);
      if (current == null) continue;
      const grossPct = (current - pos.entryVSol) / pos.entryVSol;
      const pctOfSize = grossPct - 0.02;
      const ageMs = Date.now() - pos.openedAt.getTime();
      const exit =
        pctOfSize >= TP_PCT ? "tp"
        : pctOfSize <= -SL_PCT ? "sl"
        : ageMs >= MAX_HOLD_MS ? "timeout"
        : null;
      if (!exit) continue;
      const closed = await paperClose({
        positionId: pos.id,
        reason: `shadow_${exit}`,
        correlationId: `shadow-close-${pos.id}`,
      });
      if (!closed.ok) {
        log.warn("shadow close rejected", { id: pos.id.toString(), reason: closed.reason });
        continue;
      }
      await recordOutcome({
        source: "paper",
        tradeId: pos.id,
        entryVSol: pos.entryVSol,
        exitVSol: closed.data.exitPrice,
        pnlSol: closed.data.realizedPnlSol,
        pctOfSize: closed.data.pctOfSize,
        exitReason: `shadow_${exit}`,
        holdSeconds: ageMs / 1000,
        action: pos.action,
        modulesAtEntry: pos.modulesAtEntry,
      });
    }
  }

  async function handleEntries() {
    const cb = await readState();
    if (cb.state === "HALTED") return;

    const pending = await fetchDecisionsNeedingShadow(120);
    let opened = 0;
    for (const d of pending) {
      if (d.action !== "BUY_STRONG") continue;

      const flags = await fetchMintFlags(d.mint);
      if (flags?.hasBundle || flags?.mechanicalUptrend) continue;
      const rug = await fetchRugLabel(d.mint);
      if (rug?.label === "rugged" || rug?.label === "stalled") continue;

      const v = await latestVSolFor(d.mint);
      if (v == null || v <= 0) continue;

      const insider = await analyzeMintInsiders(d.mint);
      const flow = await fetchMintFlow(d.mint);
      const qual = await qualifyEntry({
        mint: d.mint,
        action: d.action,
        confluenceScore: d.confluenceScore ?? 0,
        moduleScores: d.moduleScores,
        vSol: v,
        sizeSol,
        flow,
        flags,
        insider,
        takeProfitPct: TP_PCT,
      });
      if (!qual.allow) continue;

      const openResult = await paperOpen({
        mint: d.mint,
        sizeSol,
        entryFeatures: {
          entry_v_sol: v,
          action: d.action,
          decision_id: d.id.toString(),
          purpose: "shadow_learn",
          auto: true,
          shadow: true,
          gateConfidence: qual.gateConfidence,
          smartMoneyCount: insider.smartMoneyCount,
          insiderBoost: qual.insiderBoost,
        },
        modulesAtEntry: d.moduleScores,
        decisionId: d.id,
        correlationId: `shadow-open-${d.id}`,
      });
      if (openResult.ok) opened++;
    }
    if (opened > 0) log.info("shadow entries", { opened });
  }

  async function tick() {
    try {
      await handleExits();
      await handleEntries();
    } catch (err) {
      log.warn("tick failed", { err: String(err) });
    }
  }

  const interval = setInterval(() => tick().catch(() => undefined), TICK_MS);
  setTimeout(() => tick().catch(() => undefined), 5_000);
  return () => clearInterval(interval);
}
