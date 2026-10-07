/**
 * The risk-day definition lives in @spr/trading so the paper executor (inside
 * the package) and the app share ONE implementation (M02). Re-exported here so
 * app-side callers keep a stable import path.
 *
 * Imports the LEAF subpath, not the package barrel: the barrel pulls in
 * @spr/db -> pg -> node:fs, which cannot be bundled for the browser.
 */
export {
  RISK_TIMEZONE,
  startOfRiskDay,
  riskDayWindow,
  riskDayKey,
  isSameRiskDay,
  dailyLossSol,
} from "@spr/trading/risk-day";
