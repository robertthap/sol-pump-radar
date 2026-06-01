import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rugLabels } from "@/lib/db/schema";

export type RugLabelDto = {
  mint: string;
  label: "rugged" | "stalled" | "active" | string;
  labeledAt: string;
  lastEventAt: string | null;
  inactivitySeconds: number;
  peakVSol: number | null;
  finalVSol: number | null;
  drawdown: number | null;
  trades: number | null;
  uniqueBuyers: number | null;
  reason: string | null;
  evidence: Record<string, unknown> | null;
};

export async function fetchRugLabel(mint: string): Promise<RugLabelDto | null> {
  const r = await getDb().execute(sql`
    SELECT * FROM rug_labels WHERE mint = ${mint} LIMIT 1
  `);
  type Raw = {
    mint: string;
    label: string;
    labeled_at: Date | string;
    last_event_at: Date | string | null;
    inactivity_seconds: number;
    peak_v_sol: number | null;
    final_v_sol: number | null;
    drawdown: number | null;
    trades: number | null;
    unique_buyers: number | null;
    reason: string | null;
    evidence: Record<string, unknown> | null;
  };
  const row = (r as unknown as { rows: Raw[] }).rows[0];
  if (!row) return null;
  return {
    mint: row.mint,
    label: row.label,
    labeledAt: row.labeled_at instanceof Date ? row.labeled_at.toISOString() : String(row.labeled_at),
    lastEventAt: row.last_event_at
      ? row.last_event_at instanceof Date ? row.last_event_at.toISOString() : String(row.last_event_at)
      : null,
    inactivitySeconds: row.inactivity_seconds,
    peakVSol: row.peak_v_sol,
    finalVSol: row.final_v_sol,
    drawdown: row.drawdown,
    trades: row.trades,
    uniqueBuyers: row.unique_buyers,
    reason: row.reason,
    evidence: row.evidence,
  };
}

export async function fetchRugLabels(mints: string[]): Promise<Map<string, RugLabelDto>> {
  if (mints.length === 0) return new Map();
  const r = await getDb().execute(sql`
    SELECT mint, label, labeled_at, last_event_at, inactivity_seconds,
           peak_v_sol, final_v_sol, drawdown, trades, unique_buyers, reason
    FROM rug_labels
    WHERE mint = ANY(${sql.raw(`ARRAY[${mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")}]`)})
  `);
  type Raw = {
    mint: string;
    label: string;
    labeled_at: Date | string;
    last_event_at: Date | string | null;
    inactivity_seconds: number;
    peak_v_sol: number | null;
    final_v_sol: number | null;
    drawdown: number | null;
    trades: number | null;
    unique_buyers: number | null;
    reason: string | null;
  };
  const out = new Map<string, RugLabelDto>();
  for (const row of (r as unknown as { rows: Raw[] }).rows) {
    out.set(row.mint, {
      mint: row.mint,
      label: row.label,
      labeledAt: row.labeled_at instanceof Date ? row.labeled_at.toISOString() : String(row.labeled_at),
      lastEventAt: row.last_event_at
        ? row.last_event_at instanceof Date ? row.last_event_at.toISOString() : String(row.last_event_at)
        : null,
      inactivitySeconds: row.inactivity_seconds,
      peakVSol: row.peak_v_sol,
      finalVSol: row.final_v_sol,
      drawdown: row.drawdown,
      trades: row.trades,
      uniqueBuyers: row.unique_buyers,
      reason: row.reason,
      evidence: null,
    });
  }
  return out;
}

export type UpsertRugLabel = {
  mint: string;
  label: "rugged" | "stalled" | "active";
  lastEventAt: Date | null;
  inactivitySeconds: number;
  peakVSol: number | null;
  finalVSol: number | null;
  drawdown: number | null;
  trades: number;
  uniqueBuyers: number;
  reason: string;
  evidence: Record<string, unknown>;
};

export async function upsertRugLabel(opts: UpsertRugLabel): Promise<void> {
  await getDb()
    .insert(rugLabels)
    .values({
      mint: opts.mint,
      label: opts.label,
      labeledAt: new Date(),
      lastEventAt: opts.lastEventAt,
      inactivitySeconds: opts.inactivitySeconds,
      peakVSol: opts.peakVSol,
      finalVSol: opts.finalVSol,
      drawdown: opts.drawdown,
      trades: opts.trades,
      uniqueBuyers: opts.uniqueBuyers,
      reason: opts.reason.slice(0, 200),
      evidence: opts.evidence,
    })
    .onConflictDoUpdate({
      target: rugLabels.mint,
      set: {
        label: opts.label,
        labeledAt: new Date(),
        lastEventAt: opts.lastEventAt,
        inactivitySeconds: opts.inactivitySeconds,
        peakVSol: opts.peakVSol,
        finalVSol: opts.finalVSol,
        drawdown: opts.drawdown,
        trades: opts.trades,
        uniqueBuyers: opts.uniqueBuyers,
        reason: opts.reason.slice(0, 200),
        evidence: opts.evidence,
      },
    });
}

export type RugPerformance24h = {
  creates24h: number;
  labelled24h: number;
  rugged24h: number;
  stalled24h: number;
  active24h: number;
  ruggedPctOfLabelled: number;
  /** Rugged tokens that pumped ≥50% from first pool SOL before dying */
  ruggedPumped50Pct: number;
  ruggedPumped100Pct: number;
  ruggedPumped50PctRate: number;
  ruggedWithVolume10Trades: number;
  avgPeakVSolRugged: number | null;
  avgDrawdownRugged: number | null;
  /** Still trading (not rugged) in last 24h */
  survivors24h: number;
  survivorRate: number;
  lessons: string[];
};

export async function fetchRugPerformance24h(): Promise<RugPerformance24h> {
  const r = await getDb().execute(sql`
    WITH creates_24h AS (
      SELECT mint::text AS mint FROM tokens
      WHERE created_at > now() - interval '24 hours'
    ),
    first_v AS (
      SELECT DISTINCT ON (e.mint)
        e.mint::text AS mint,
        e.v_sol_after::float8 AS first_v
      FROM events e
      WHERE e.mint IN (SELECT mint FROM creates_24h)
        AND e.v_sol_after IS NOT NULL AND e.v_sol_after > 0
      ORDER BY e.mint, e.ts ASC
    ),
    rugged AS (
      SELECT rl.*, fv.first_v,
        CASE WHEN fv.first_v > 0 AND rl.peak_v_sol IS NOT NULL
          THEN rl.peak_v_sol / fv.first_v ELSE NULL END AS pump_multiple
      FROM rug_labels rl
      JOIN creates_24h c ON c.mint = rl.mint
      LEFT JOIN first_v fv ON fv.mint = rl.mint
      WHERE rl.label = 'rugged'
    )
    SELECT
      (SELECT COUNT(*)::int FROM creates_24h) AS creates_24h,
      (SELECT COUNT(*)::int FROM rug_labels rl JOIN creates_24h c ON c.mint = rl.mint) AS labelled_24h,
      (SELECT COUNT(*)::int FROM rugged) AS rugged_24h,
      (SELECT COUNT(*)::int FROM rug_labels rl JOIN creates_24h c ON c.mint = rl.mint WHERE rl.label = 'stalled') AS stalled_24h,
      (SELECT COUNT(*)::int FROM rug_labels rl JOIN creates_24h c ON c.mint = rl.mint WHERE rl.label = 'active') AS active_24h,
      (SELECT COUNT(*)::int FROM rugged WHERE pump_multiple >= 1.5) AS pumped_50,
      (SELECT COUNT(*)::int FROM rugged WHERE pump_multiple >= 2.0) AS pumped_100,
      (SELECT COUNT(*)::int FROM rugged WHERE trades >= 10) AS vol_10,
      (SELECT AVG(peak_v_sol)::float8 FROM rugged) AS avg_peak_rugged,
      (SELECT AVG(drawdown)::float8 FROM rugged) AS avg_dd_rugged
  `);
  type Raw = {
    creates_24h: number;
    labelled_24h: number;
    rugged_24h: number;
    stalled_24h: number;
    active_24h: number;
    pumped_50: number;
    pumped_100: number;
    vol_10: number;
    avg_peak_rugged: number | null;
    avg_dd_rugged: number | null;
  };
  const row = (r as unknown as { rows: Raw[] }).rows[0]!;
  const rugged = row.rugged_24h;
  const labelled = row.labelled_24h;
  const creates = row.creates_24h;
  const survivors = row.active_24h + row.stalled_24h;
  const pumped50Rate = rugged > 0 ? row.pumped_50 / rugged : 0;

  const lessons: string[] = [];
  if (rugged > 0 && pumped50Rate >= 0.3) {
    lessons.push(
      `${Math.round(pumped50Rate * 100)}% of rugged coins pumped ≥50% first — take profit early; don't chase late entries.`,
    );
  }
  if (row.vol_10 > 0 && rugged > 0 && row.vol_10 / rugged < 0.5) {
    lessons.push("Many rugs had thin volume (<10 trades) — system down-weights thin 5m volume.");
  }
  if (row.avg_dd_rugged != null && row.avg_dd_rugged < -0.7) {
    lessons.push("Average drawdown on rugs is steep — honor stop-loss and inactivity exits.");
  }
  if (row.stalled_24h > rugged * 0.5) {
    lessons.push("Stalled labels fire before full rug — treat 'Slowing' as exit warning.");
  }
  if (lessons.length === 0) {
    lessons.push("Collecting more 24h labels — keep ingestor running for sharper stats.");
  }

  return {
    creates24h: creates,
    labelled24h: labelled,
    rugged24h: rugged,
    stalled24h: row.stalled_24h,
    active24h: row.active_24h,
    ruggedPctOfLabelled: labelled > 0 ? rugged / labelled : 0,
    ruggedPumped50Pct: row.pumped_50,
    ruggedPumped100Pct: row.pumped_100,
    ruggedPumped50PctRate: pumped50Rate,
    ruggedWithVolume10Trades: row.vol_10,
    avgPeakVSolRugged: row.avg_peak_rugged,
    avgDrawdownRugged: row.avg_dd_rugged,
    survivors24h: survivors,
    survivorRate: creates > 0 ? survivors / creates : 0,
    lessons,
  };
}

export type RugTrapExample = {
  mint: string;
  symbol: string | null;
  pumpMultiple: number | null;
  peakVSol: number | null;
  finalVSol: number | null;
  drawdown: number | null;
  trades: number | null;
  uniqueBuyers: number | null;
  labeledAt: string;
};

export async function fetchRugTrapExamples(limit = 12): Promise<RugTrapExample[]> {
  const r = await getDb().execute(sql`
    WITH first_v AS (
      SELECT DISTINCT ON (e.mint)
        e.mint::text AS mint,
        e.v_sol_after::float8 AS first_v
      FROM events e
      WHERE e.v_sol_after IS NOT NULL AND e.v_sol_after > 0
      ORDER BY e.mint, e.ts ASC
    )
    SELECT
      rl.mint,
      t.symbol,
      rl.peak_v_sol,
      rl.final_v_sol,
      rl.drawdown,
      rl.trades,
      rl.unique_buyers,
      rl.labeled_at,
      CASE WHEN fv.first_v > 0 AND rl.peak_v_sol IS NOT NULL
        THEN rl.peak_v_sol / fv.first_v ELSE NULL END AS pump_multiple
    FROM rug_labels rl
    JOIN tokens t ON t.mint = rl.mint
    LEFT JOIN first_v fv ON fv.mint = rl.mint
    WHERE rl.label = 'rugged'
      AND t.created_at > now() - interval '24 hours'
      AND rl.peak_v_sol IS NOT NULL
      AND fv.first_v IS NOT NULL
      AND rl.peak_v_sol / fv.first_v >= 1.5
    ORDER BY pump_multiple DESC NULLS LAST
    LIMIT ${sql.raw(String(Math.min(50, Math.max(1, limit))))}
  `);
  type Raw = {
    mint: string;
    symbol: string | null;
    peak_v_sol: number | null;
    final_v_sol: number | null;
    drawdown: number | null;
    trades: number | null;
    unique_buyers: number | null;
    labeled_at: Date | string;
    pump_multiple: number | null;
  };
  return (r as unknown as { rows: Raw[] }).rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    pumpMultiple: row.pump_multiple,
    peakVSol: row.peak_v_sol,
    finalVSol: row.final_v_sol,
    drawdown: row.drawdown,
    trades: row.trades,
    uniqueBuyers: row.unique_buyers,
    labeledAt: row.labeled_at instanceof Date ? row.labeled_at.toISOString() : String(row.labeled_at),
  }));
}

export async function fetchRugStats(): Promise<{
  total: number;
  rugged: number;
  stalled: number;
  active: number;
  ruggedPct: number;
  avgPeakVSol: number | null;
  avgDrawdown: number | null;
}> {
  const r = await getDb().execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE label = 'rugged')::int  AS rugged,
      COUNT(*) FILTER (WHERE label = 'stalled')::int AS stalled,
      COUNT(*) FILTER (WHERE label = 'active')::int  AS active,
      AVG(peak_v_sol)::float8                          AS avg_peak,
      AVG(drawdown)::float8                            AS avg_dd
    FROM rug_labels
  `);
  type Raw = {
    total: number;
    rugged: number;
    stalled: number;
    active: number;
    avg_peak: number | null;
    avg_dd: number | null;
  };
  const row = (r as unknown as { rows: Raw[] }).rows[0]!;
  return {
    total: row.total,
    rugged: row.rugged,
    stalled: row.stalled,
    active: row.active,
    ruggedPct: row.total > 0 ? row.rugged / row.total : 0,
    avgPeakVSol: row.avg_peak,
    avgDrawdown: row.avg_dd,
  };
}
