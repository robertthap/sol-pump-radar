/**
 * Coin Journey radar snapshot (PURE): database rows for one time window in, the counts and sample coins the /radar
 * screen draws out. The queries live in lib/radar/snapshot-query.ts; everything that decides what a row means lives
 * here so it can be tested without a database.
 *
 * Every stage counts distinct coins that did that thing inside the window, so a later stage can count coins its
 * parent handled before the window opened; the layout draws that honestly rather than hiding it.
 */
import type { Count } from "@/lib/radar/layout";

export const RADAR_WINDOWS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 } as const;
export type RadarWindow = keyof typeof RADAR_WINDOWS;

export function parseRadarWindow(raw: string | null | undefined): { key: RadarWindow; seconds: number } {
  const key = raw && Object.hasOwn(RADAR_WINDOWS, raw) ? (raw as RadarWindow) : "5m";
  return { key, seconds: RADAR_WINDOWS[key] };
}

/** Sample coins kept per stage: enough for the hover list and to spot new arrivals between polls. */
export const SAMPLES_PER_STAGE = 25;

/** What the auto-trader recorded about a candidate (radar_events). */
export type RadarEventStage = "gate_passed" | "decision_committed" | "rejected" | "skipped";

/** First event the worker ingested for a coin, inside the window. */
export type IngestedRow = { mint: string; ts: string };
/** The scorer's verdicts on a coin inside the window (decision_log). */
export type ScoredRow = { mint: string; ts: string; score: number | null; bought: boolean; avoidReason: string | null };
export type GateRow = {
  mint: string;
  ts: string;
  stage: RadarEventStage;
  sub_stage: string | null;
  score: number | null;
  detail: string | null;
};
/** An auto-trade position that was opened, held or closed during the window. */
export type PositionRow = {
  mint: string;
  lane: "paper" | "live";
  openedAt: string;
  closedAt: string | null;
  /** Opened inside the window (false: opened earlier and still held, or closed, during it). */
  openedInWindow: boolean;
  closedInWindow: boolean;
  exitReason: string | null;
  pnlSol: number | null;
  score: number | null;
  dryRun: boolean;
};

export type RadarSample = {
  stage: string;
  sub_stage: string | null;
  mint: string;
  score: number | null;
  created_at: string;
  detail: string | null;
  pnl_sol: number | null;
};

export type RadarTotals = {
  entered: number;
  scored: number;
  /** Coins stopped anywhere before a position: never scored, avoided, or refused by a gate or a skip. */
  stopped: number;
  /** Positions opened inside the window. */
  traded: number;
  open: number;
  closed: number;
  won: number;
  lost: number;
  realizedPnlSol: number;
};

export type RadarSnapshot = {
  window: RadarWindow;
  windowSeconds: number;
  generatedAt: string;
  counts: Count[];
  samples: RadarSample[];
  totals: RadarTotals;
  bot: { running: boolean; mode: "paper" | "live" | null; workerAlive: boolean };
};

/**
 * Exit door for a stored close reason. Paper positions store decidePaperExit's codes (tp, trail, sl, stagnation,
 * timeout), optionally with "+tp1" when a partial take-profit came first; closes the bot did not choose (session end,
 * restart, stale sweep, manual sells) are forced.
 */
export function exitSubStage(reason: string | null | undefined): string {
  const base = (reason ?? "").toLowerCase().replace(/\+tp1$/, "").trim();
  if (base === "tp" || base === "take_profit" || base === "tp1") return "take_profit";
  if (base === "trail" || base === "trailing" || base === "trailing_stop") return "trailing_stop";
  if (base === "stagnation") return "flat_cut";
  if (base === "sl" || base === "stop_loss") return "stop_loss";
  if (base === "timeout" || base === "max_hold") return "max_hold";
  return "forced_close";
}

export type SnapshotRows = {
  ingested: IngestedRow[];
  scored: ScoredRow[];
  gates: GateRow[];
  positions: PositionRow[];
};

export function composeRadarSnapshot(
  rows: SnapshotRows,
  meta: { window: RadarWindow; generatedAt: string; bot: RadarSnapshot["bot"] },
): RadarSnapshot {
  const byStage = new Map<string, RadarSample[]>();
  const add = (stage: string, sub: string | null, sample: Omit<RadarSample, "stage" | "sub_stage">) => {
    const id = sub ? `${stage}::${sub}` : stage;
    const list = byStage.get(id);
    const s: RadarSample = { stage, sub_stage: sub, ...sample };
    if (list) list.push(s);
    else byStage.set(id, [s]);
  };
  const plain = (mint: string, created_at: string, score: number | null = null, detail: string | null = null) => ({
    mint,
    created_at,
    score,
    detail,
    pnl_sol: null,
  });

  const scoredByMint = new Map(rows.scored.map((r) => [r.mint, r]));
  for (const r of latestPerMint(rows.ingested)) {
    add("ingested", null, plain(r.mint, r.ts, scoredByMint.get(r.mint)?.score ?? null));
    if (!scoredByMint.has(r.mint)) add("rejected", "not_scored", plain(r.mint, r.ts, null, "no score from the intelligence lane in this window"));
  }
  for (const r of latestPerMint(rows.scored)) {
    add("scored", null, plain(r.mint, r.ts, r.score));
    if (!r.bought) add("rejected", "avoid", plain(r.mint, r.ts, r.score, r.avoidReason));
  }

  // A coin counts once per pass stage, and at most once as stopped: at the last gate or skip it hit, and only if it
  // did not get further afterwards (a candidate refused for "no price yet" often passes a tick later).
  const passed = new Map<string, GateRow>();
  const committed = new Map<string, GateRow>();
  const lastStop = new Map<string, GateRow>();
  for (const g of rows.gates) {
    keepLatest(g.stage === "gate_passed" ? passed : g.stage === "decision_committed" ? committed : lastStop, g);
  }
  for (const g of passed.values()) add("gate_passed", null, plain(g.mint, g.ts, g.score, g.detail));
  for (const g of committed.values()) add("decision_committed", null, plain(g.mint, g.ts, g.score, g.detail));
  for (const g of lastStop.values()) {
    const beforeGates = g.stage === "rejected" || g.sub_stage === "already_in" || g.sub_stage === "max_positions";
    const gotFurther = beforeGates
      ? reachedSince(passed.get(g.mint), g.ts)
      : g.sub_stage !== "fill_rejected" && reachedSince(committed.get(g.mint), g.ts);
    if (gotFurther) continue;
    add(g.stage, g.sub_stage ?? "unknown", plain(g.mint, g.ts, g.score, g.detail));
  }

  let traded = 0;
  let open = 0;
  let won = 0;
  let lost = 0;
  let realizedPnlSol = 0;
  for (const p of rows.positions) {
    const detail = [p.openedInWindow ? "opened in window" : "held from earlier", p.dryRun ? "dry-run" : null]
      .filter(Boolean)
      .join(" · ");
    add("entry", p.lane, { mint: p.mint, created_at: p.openedAt, score: p.score, detail, pnl_sol: null });
    if (p.openedInWindow) traded++;
    if (p.closedAt == null) open++;
    if (p.closedInWindow && p.closedAt != null) {
      const pnl = p.pnlSol != null && Number.isFinite(p.pnlSol) ? p.pnlSol : null;
      const sample = { mint: p.mint, created_at: p.closedAt, score: p.score, detail: p.exitReason, pnl_sol: pnl };
      add("exit", exitSubStage(p.exitReason), sample);
      add("outcome", null, sample);
      if (pnl != null) {
        realizedPnlSol += pnl;
        if (pnl > 0) won++;
        else lost++;
      }
    }
  }

  const counts: Count[] = [];
  const samples: RadarSample[] = [];
  let stopped = 0;
  for (const [id, list] of [...byStage.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [stage, sub] = id.includes("::") ? [id.slice(0, id.indexOf("::")), id.slice(id.indexOf("::") + 2)] : [id, null];
    counts.push({ stage, sub_stage: sub, count: list.length });
    if (stage === "rejected" || stage === "skipped") stopped += list.length;
    samples.push(...[...list].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, SAMPLES_PER_STAGE));
  }

  return {
    window: meta.window,
    windowSeconds: RADAR_WINDOWS[meta.window],
    generatedAt: meta.generatedAt,
    counts,
    samples,
    totals: {
      entered: byStage.get("ingested")?.length ?? 0,
      scored: byStage.get("scored")?.length ?? 0,
      stopped,
      traded,
      open,
      closed: byStage.get("outcome")?.length ?? 0,
      won,
      lost,
      realizedPnlSol,
    },
    bot: meta.bot,
  };
}

/** One row per mint: its latest. */
function latestPerMint<T extends { mint: string; ts: string }>(rows: T[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const prev = out.get(r.mint);
    if (!prev || Date.parse(r.ts) > Date.parse(prev.ts)) out.set(r.mint, r);
  }
  return [...out.values()];
}

function keepLatest(m: Map<string, GateRow>, g: GateRow): void {
  const prev = m.get(g.mint);
  if (!prev || Date.parse(g.ts) >= Date.parse(prev.ts)) m.set(g.mint, g);
}

function reachedSince(row: GateRow | undefined, ts: string): boolean {
  return row != null && Date.parse(row.ts) >= Date.parse(ts);
}
