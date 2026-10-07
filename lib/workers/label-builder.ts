import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import {
  fetchMaturingSnapshots,
  upsertOutcomeLabel,
  type MaturingSnapshot,
} from "@/lib/db/repos/measurement";
import { gapOverlapKind } from "@/lib/db/repos/ingest-gaps";
import { censorDecision } from "@/lib/workers/gap-window";
import { touchWorker } from "@/lib/workers/heartbeat";

/**
 * Upgrade-plan Phase 1 — async label maturation.
 *
 * For each snapshot whose horizons have matured, compute forward outcomes and
 * write outcome_labels. Forward "value return" uses the bonding-curve model
 * (position value ∝ vSol²), the same basis the paper engine books PnL on, so a
 * label is directly comparable to a realised trade.
 *
 * Point-in-time safety: this lane ONLY ever reads events strictly AFTER the
 * snapshot ts and writes to outcome_labels — it never touches the feature row.
 *
 * NOTE: returns are computed on the events.v_sol_after series. Since T1.2 this
 * spans BOTH venues — bonding-curve rows (venue='curve') AND PumpSwap rows
 * (venue='pumpswap', effective vSol, continuous basis). So a coin that graduates
 * within the label horizon now gets a real forward return from on-chain DEX data
 * instead of a null (the old "DEX-quote labeler is a follow-up" gap). The
 * forwardOutcomes query intentionally has no venue filter — both are the same
 * effective-vSol basis. (Caveat until T1.2g: PumpSwap has no gap recovery yet,
 * so a graduated-coin label spanning a PumpSwap WS drop could be incomplete.)
 */
const log = logger("label-builder");
const TICK_MS = 60_000;
const SIX_HOURS_SEC = 6 * 3600;
const BATCH = 60;

type ForwardRow = {
  v5: number | null;
  v30: number | null;
  v1h: number | null;
  v6h: number | null;
  vmax: number | null;
  vmin: number | null;
  peak_sec: number | null;
  grad_sec: number | null;
};

/** (v / ref)² − 1 — bonding-curve value return; null when the point is missing. */
function valueReturn(v: number | null, ref: number): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return (v / ref) ** 2 - 1;
}

async function forwardOutcomes(mint: string, baseIso: string, ref: number): Promise<ForwardRow> {
  const res = await getDb().execute(sql`
    WITH w AS (
      SELECT ts, v_sol_after AS v
      FROM events
      WHERE mint = ${mint}
        AND v_sol_after IS NOT NULL
        AND ts > ${baseIso}::timestamptz
        AND ts <= ${baseIso}::timestamptz + interval '6 hours'
    )
    SELECT
      (SELECT v FROM w WHERE ts <= ${baseIso}::timestamptz + interval '5 minutes'  ORDER BY ts DESC LIMIT 1)::float8 AS v5,
      (SELECT v FROM w WHERE ts <= ${baseIso}::timestamptz + interval '30 minutes' ORDER BY ts DESC LIMIT 1)::float8 AS v30,
      (SELECT v FROM w WHERE ts <= ${baseIso}::timestamptz + interval '1 hour'     ORDER BY ts DESC LIMIT 1)::float8 AS v1h,
      (SELECT v FROM w WHERE ts <= ${baseIso}::timestamptz + interval '6 hours'    ORDER BY ts DESC LIMIT 1)::float8 AS v6h,
      (SELECT MAX(v) FROM w)::float8 AS vmax,
      (SELECT MIN(v) FROM w)::float8 AS vmin,
      (SELECT EXTRACT(EPOCH FROM (ts - ${baseIso}::timestamptz)) FROM w ORDER BY v DESC LIMIT 1)::float8 AS peak_sec,
      (SELECT EXTRACT(EPOCH FROM (graduated_at - ${baseIso}::timestamptz))
         FROM tokens WHERE mint = ${mint} AND graduated_at > ${baseIso}::timestamptz)::float8 AS grad_sec
  `);
  return (res as unknown as { rows: ForwardRow[] }).rows[0] ?? {
    v5: null, v30: null, v1h: null, v6h: null, vmax: null, vmin: null, peak_sec: null, grad_sec: null,
  };
}

async function labelOne(s: MaturingSnapshot): Promise<boolean> {
  const complete = s.ageSec >= SIX_HOURS_SEC;
  const baseIso = s.ts.toISOString();

  // T1.1 — gap gate: if an unrecovered WS coverage gap overlaps this snapshot's
  // horizon, the forward returns would be computed over incomplete event data.
  // Mark the label blocked_reason='gap' and bail; once recovery completes (or
  // the gap is unrecoverable + expired), the next pass will succeed/finalize.
  const censor = censorDecision(await gapOverlapKind(s.ts, SIX_HOURS_SEC));
  if (censor.reason) {
    await upsertOutcomeLabel({
      snapshotId: s.id, mint: s.mint, baseTs: s.ts,
      ret5m: null, ret30m: null, ret1h: null, ret6h: null,
      maxGainPct: null, maxDrawdownPct: null, isRug: null, isBreakout: null,
      timeToPeakSec: null, timeToGraduationSec: null,
      // Never marked complete: a censored label is MARKED, not deleted, and not
      // counted as clean data. 'gap' may still be retried once recovery
      // finishes; 'gap_unrecoverable' is terminal and must never train a model.
      horizonsComplete: false,
      blockedReason: censor.reason,
    });
    return true;
  }

  // No curve price basis → can only finalise (give up) once fully matured.
  if (s.refVSol == null || s.refVSol <= 0) {
    if (!complete) return false;
    await upsertOutcomeLabel({
      snapshotId: s.id, mint: s.mint, baseTs: s.ts,
      ret5m: null, ret30m: null, ret1h: null, ret6h: null,
      maxGainPct: null, maxDrawdownPct: null, isRug: null, isBreakout: null,
      timeToPeakSec: null, timeToGraduationSec: null, horizonsComplete: true,
    });
    return true;
  }

  const f = await forwardOutcomes(s.mint, baseIso, s.refVSol);
  const maxGain = valueReturn(f.vmax, s.refVSol);
  const maxDraw = valueReturn(f.vmin, s.refVSol);
  await upsertOutcomeLabel({
    snapshotId: s.id,
    mint: s.mint,
    baseTs: s.ts,
    ret5m: valueReturn(f.v5, s.refVSol),
    ret30m: valueReturn(f.v30, s.refVSol),
    ret1h: valueReturn(f.v1h, s.refVSol),
    ret6h: valueReturn(f.v6h, s.refVSol),
    maxGainPct: maxGain,
    maxDrawdownPct: maxDraw,
    isRug: maxDraw == null ? null : maxDraw <= -0.85,
    isBreakout: maxGain == null ? null : maxGain >= 1.0,
    timeToPeakSec: f.peak_sec,
    timeToGraduationSec: f.grad_sec,
    horizonsComplete: complete,
  });
  return true;
}

export async function startLabelBuilder() {
  log.info("label-builder starting", { tickMs: TICK_MS });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    touchWorker("label-builder");
    try {
      const maturing = await fetchMaturingSnapshots(BATCH);
      let labelled = 0;
      for (const s of maturing) {
        try {
          if (await labelOne(s)) labelled++;
        } catch (e) {
          log.warn("label one failed", { id: s.id, err: String(e) });
        }
      }
      if (labelled > 0) log.debug("labelled snapshots", { labelled, scanned: maturing.length });
    } catch (e) {
      log.warn("label-builder tick failed", { err: String(e) });
    } finally {
      touchWorker("label-builder", { tickMs: Date.now() - t0 });
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return async () => clearInterval(id);
}
