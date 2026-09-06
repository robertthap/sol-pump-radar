/**
 * Ticker snapshot — the ONE source of truth for the /trade screen (pure, testable).
 *
 * Two existing endpoints compute unrealized P&L differently and disagree:
 * /api/settings/mode-lite uses the bonding-curve vSol path, /api/auto/positions
 * prefers the real-mcap path the worker books against. Putting the hero total
 * from one and the rows from the other on the same screen would show two
 * contradictory numbers. So the hero is DERIVED from the rows here, by
 * construction: sum(position.pnlSol) === unrealizedPnlSol, always.
 *
 * Everything in this file is a pure function over already-fetched data. The
 * route (app/api/ticker) does the fetching and binds these together.
 */

export type TickerSourceStatus =
  | "live"
  | "stale"
  | "no_session"
  | "stopped"
  | "halted"
  | "offline"
  | "error";

/** Snapshot older than this is shown greyed with "Updated Ns ago", never as current. */
export const TICKER_STALE_MS = 5_000;

export type TickerPosition = {
  id: string;
  mint: string;
  symbol: string | null;
  source: "paper" | "live";
  sizeSol: number;
  /** Unrealized P&L in SOL; null when no price could be resolved yet. */
  pnlSol: number | null;
  /** Unrealized P&L as a fraction of size (0.087 = +8.7%). */
  pctOfSize: number | null;
  entryMcapUsd: number | null;
  currentMcapUsd: number | null;
  entryVSol: number | null;
  currentVSol: number | null;
  openedAt: string;
};

/** A position closed during this session - realized P&L and why it closed. */
export type TickerClosedPosition = {
  id: string;
  mint: string;
  symbol: string | null;
  source: "paper" | "live";
  sizeSol: number;
  /** Realized P&L in SOL. */
  pnlSol: number | null;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
};

export type TickerPortfolio = {
  /** Sum of open.sizeSol — money currently at risk. */
  investedSol: number;
  /** Sum of (sizeSol + pnlSol) — what the open positions are worth now. */
  currentValueSol: number;
  /** Uncommitted cash. null when not knowable (real mode without wallet status). */
  availableSol: number | null;
  unrealizedPnlSol: number;
  /** unrealized / invested; 0 when nothing is invested. */
  unrealizedPct: number;
  realizedPnlSol: number;
  totalPnlSol: number;
  openCount: number;
  /** Rows whose P&L could not be priced; they count in invested but not in P&L. */
  unpricedCount: number;
};

export type TickerLogKind = "open" | "close" | "tp1" | "session" | "halt" | "error";

export type TickerLogEntry = {
  id: string;
  ts: string;
  kind: TickerLogKind;
  mint: string | null;
  symbol: string | null;
  message: string;
  pnlSol: number | null;
  source: "paper" | "live" | "system";
};

type PositionLike = Pick<TickerPosition, "sizeSol" | "pnlSol">;

export function composePortfolio(
  open: readonly PositionLike[],
  realizedPnlSol: number,
  availableSol: number | null,
): TickerPortfolio {
  let invested = 0;
  let unrealized = 0;
  let unpriced = 0;
  for (const p of open) {
    invested += p.sizeSol;
    if (p.pnlSol == null || !Number.isFinite(p.pnlSol)) unpriced += 1;
    else unrealized += p.pnlSol;
  }
  const realized = Number.isFinite(realizedPnlSol) ? realizedPnlSol : 0;
  return {
    investedSol: invested,
    currentValueSol: invested + unrealized,
    availableSol,
    unrealizedPnlSol: unrealized,
    unrealizedPct: invested > 0 ? unrealized / invested : 0,
    realizedPnlSol: realized,
    totalPnlSol: realized + unrealized,
    openCount: open.length,
    unpricedCount: unpriced,
  };
}

/**
 * Log filter — important events only. The activity log is dominated by `skip`
 * entries (every rejected candidate, dozens a minute); those never reach the
 * browser. What remains is a record of what happened to capital and bot state.
 */
export type LogLike = {
  id: string;
  ts: string;
  kind: string;
  mint: string | null;
  symbol: string | null;
  message: string;
  pnlSol: number | null;
  source: "paper" | "live" | "system";
};

const IMPORTANT_KINDS: ReadonlySet<string> = new Set(["open", "close", "tp1"]);

function classifySystemMessage(message: string): TickerLogKind | null {
  const m = message.toLowerCase();
  if (/halt|resume|paused|kill.?switch|cooldown/.test(m)) return "halt";
  if (/session (started|stopped)|auto-?trad(e|ing) (started|stopped)|daily loss cap|stopped:/.test(m)) return "session";
  if (/error|failed|rejected/.test(m)) return "error";
  return null;
}

export function filterImportantLogs(entries: readonly LogLike[], limit = 20): TickerLogEntry[] {
  const out: TickerLogEntry[] = [];
  for (const e of entries) {
    let kind: TickerLogKind | null = null;
    if (e.kind === "skip") continue;
    if (IMPORTANT_KINDS.has(e.kind)) kind = e.kind as TickerLogKind;
    else if (e.source === "system") kind = classifySystemMessage(e.message);
    if (!kind) continue;
    out.push({ ...e, kind });
  }
  // Newest first, hard cap.
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return out.slice(0, Math.max(1, limit));
}

/**
 * Polling cadence for TickerProvider. 0 = do not poll.
 *   visible + open positions          -> 1 s
 *   visible + bot running, none open  -> 5 s
 *   hidden                            -> 0
 *   no session / stopped, none open   -> 0   (a stopped session with positions
 *                                             still open polls at 5 s so the
 *                                             orphan sweep is visible closing them)
 */
export function pickPollMs(input: {
  visible: boolean;
  openCount: number;
  botRunning: boolean;
  hasSession: boolean;
}): number {
  if (!input.visible) return 0;
  if (input.openCount > 0) return input.botRunning ? 1_000 : 5_000;
  if (input.hasSession && input.botRunning) return 5_000;
  return 0;
}

export function resolveSourceStatus(input: {
  hasSession: boolean;
  sessionActive: boolean;
  breaker: string | null;
  workerAlive: boolean;
  snapshotAgeMs: number;
}): TickerSourceStatus {
  if (!input.workerAlive) return "offline";
  if (input.breaker === "HALTED") return "halted";
  if (!input.hasSession) return "no_session";
  if (!input.sessionActive) return "stopped";
  if (input.snapshotAgeMs > TICKER_STALE_MS) return "stale";
  return "live";
}

/** Visual state of the P&L sparkline, decided by the LAST value in the series. */
export function sparklineState(series: readonly number[]): "positive" | "negative" | "flat" | "empty" {
  if (series.length === 0) return "empty";
  const last = series[series.length - 1]!;
  if (!Number.isFinite(last) || last === 0) return "flat";
  return last > 0 ? "positive" : "negative";
}

/** Mode/session snapshot the ticker forwards to TradingModeProvider.hydrate() so /trade never polls mode-lite itself. */
export type TickerModePayload = {
  mode: "demo" | "real" | null;
  needsSelection: boolean;
  activeSession: boolean;
  demo: {
    startSol: number;
    balanceSol: number;
    equitySol: number;
    realizedPnlSol: number;
    unrealizedPnlSol: number;
    lockedSol: number;
    openPositions: number;
    closedTrades: number;
  };
  real: { walletUnlocked: boolean; hasWallet: boolean; liveExecution: "on" | "off"; liveDryRun: "on" | "off" };
  shadowLearner: { enabled: boolean; sizeSol: number };
};

/** Wire shape of GET /api/ticker. Lives here (pure module) so client code never imports the route. */
export type TickerResponse = {
  serverAt: number;
  snapshotAt: number;
  stale: boolean;
  sourceStatus: TickerSourceStatus;
  session: {
    id: string;
    mode: "paper" | "live";
    status: "active" | "stopped" | "error";
    startedAt: string;
    stoppedAt: string | null;
    stopReason: string | null;
  } | null;
  status: { breaker: string; workerAlive: boolean; uiMode: "demo" | "real" | null };
  mode: TickerModePayload;
  /** Effective strategy (runtime DB override wins over .env). Switchable from BotControls. */
  signalMode: { effective: "launch" | "hybrid" | "profit"; envDefault: string };
  solUsd: number;
  solAud: number;
  portfolio: TickerPortfolio;
  positions: TickerPosition[];
  /** This session's closed trades, newest first (bounded by the snapshot's 60-row cap). */
  closedPositions: TickerClosedPosition[];
  bot: {
    running: boolean;
    sizeSol: number;
    maxDailyLossSol: number;
    maxConcurrent: number;
    /** min(session cap, PAPER_MAX_OPEN_POSITIONS) - the cap the worker actually enforces. */
    effectiveMaxConcurrent: number;
    /** PAPER_MAX_OPEN_POSITIONS itself - the operator-configured ceiling the form must not exceed. */
    maxConcurrentCeiling: number;
    /** Running with every slot taken: the entry pass returns before reading the queue. */
    slotsFull: boolean;
    /** Fresh BUY decisions in the bot's own queue window right now - what it would consider if a slot freed. */
    pendingBuySignals: number;
    takeProfitPct: number;
    stopLossPct: number;
    maxHoldMinutes: number;
    /** Flat-position cut: close a position whose peak never beat
     *  stagnationMaxPeakPct by this age. Effective values, defaults resolved. */
    stagnationMinutes: number;
    stagnationMaxPeakPct: number;
    todayLossSol: number;
    /** Smart-money entry requirement in force, and whether the boost is on.
     *  Read-only: "why is it not buying anything?" must be answerable from
     *  the screen, and "requireSmartMoney: strong" is a common answer. */
    smartMoney: { require: "off" | "weak" | "strong"; boost: boolean };
    liveExecution: "on" | "off";
    liveDryRun: "on" | "off";
    /** Prefill for the controls when no session exists. */
    defaults: { sizeSol: number; maxDailyLossSol: number; maxConcurrent: number };
  };
  logs: TickerLogEntry[];
};
