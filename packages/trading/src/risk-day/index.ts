/**
 * ONE definition of a risk day (M02) — PURE, no IO.
 *
 * Three separate daily-loss queries existed, in the paper executor, the live
 * executor and the auto-session repo, and all three asked Postgres for
 * `closed_at::date = now()::date`. That is the DATABASE SERVER's calendar day.
 * The server runs UTC, so the "day" rolled over at 10:00 or 11:00 Sydney time —
 * in the middle of the operator's trading day. A loss cap that resets at
 * mid-morning is not a daily loss cap: a bad morning and a bad afternoon are
 * counted as two different days, and twice the intended risk is permitted.
 *
 * The boundary is now Australia/Sydney local midnight, computed here, and the
 * queries take explicit UTC instants instead of asking the database what day it
 * is. DST is handled by asking the runtime rather than assuming a fixed +10:
 * Sydney moves between AEST (UTC+10) and AEDT (UTC+11), so a hardcoded offset
 * is wrong for about half the year.
 */

export const RISK_TIMEZONE = "Australia/Sydney";

type Parts = { year: number; month: number; day: number };

function zonedParts(at: Date, timeZone: string): Parts & { hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const got: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) if (p.type !== "literal") got[p.type] = p.value;
  return {
    year: Number(got.year), month: Number(got.month), day: Number(got.day),
    hour: Number(got.hour), minute: Number(got.minute), second: Number(got.second),
  };
}

/** How far the zone is ahead of UTC at this instant, in ms (DST-aware). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the Sydney day containing `at` began.
 *
 * Converges on the correct instant across a DST boundary, where naive
 * "midnight minus a fixed offset" lands an hour out.
 */
export function startOfRiskDay(at: Date, timeZone: string = RISK_TIMEZONE): Date {
  const { year, month, day } = zonedParts(at, timeZone);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = localMidnightAsUtc;
  for (let i = 0; i < 4; i++) {
    const corrected = localMidnightAsUtc - zoneOffsetMs(new Date(guess), timeZone);
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

/**
 * The half-open window [start, end) of the risk day containing `at`.
 *
 * Half-open so a trade closing exactly at midnight belongs to exactly one day —
 * never both, never neither.
 */
export function riskDayWindow(
  at: Date,
  timeZone: string = RISK_TIMEZONE,
): { start: Date; end: Date } {
  const start = startOfRiskDay(at, timeZone);
  // +36h from local midnight is always inside the NEXT local day, whichever way
  // a 1-hour DST shift moved it; taking that day's start gives the true end.
  const end = startOfRiskDay(new Date(start.getTime() + 36 * 3_600_000), timeZone);
  return { start, end };
}

/** The Sydney calendar date of an instant, as YYYY-MM-DD, for reports. */
export function riskDayKey(at: Date, timeZone: string = RISK_TIMEZONE): string {
  const { year, month, day } = zonedParts(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whether an instant falls inside the risk day containing `reference`. */
export function isSameRiskDay(a: Date, reference: Date, timeZone: string = RISK_TIMEZONE): boolean {
  const { start, end } = riskDayWindow(reference, timeZone);
  return a.getTime() >= start.getTime() && a.getTime() < end.getTime();
}

/**
 * Daily loss from realised components (M02).
 *
 * Counts what actually left the account today:
 *   - realised PnL on positions fully closed today,
 *   - realised PnL on PARTIAL closes made today, which the old queries ignored
 *     entirely because the position is still OPEN and only `closed_at` was
 *     examined — so a position that took a losing partial and had not yet
 *     closed contributed nothing to the cap,
 *   - fees on trades that produced no position at all (failed transactions).
 *
 * Returns a POSITIVE magnitude of loss, or 0 when the day is net flat or up.
 * Profits inside the day offset losses: the cap exists to stop a day running
 * away, and a day that is net up has not run away.
 */
export function dailyLossSol(input: {
  closedPnlSol: number[];
  partialPnlSol: number[];
  feesWithoutPositionSol: number[];
}): number {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const net =
    sum(input.closedPnlSol) +
    sum(input.partialPnlSol) -
    Math.abs(sum(input.feesWithoutPositionSol));
  return net < 0 ? -net : 0;
}
