/**
 * Formatting for the ticker screen. Every gain/loss is rendered as
 * SIGN + ARROW + NUMBER so meaning never depends on colour alone.
 */
export type Tone = "up" | "down" | "flat";

export function toneOf(v: number | null | undefined): Tone {
  if (v == null || !Number.isFinite(v) || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}

/** Tailwind text colour for a tone. Neutral for unchanged/unknown. */
export function toneClass(t: Tone): string {
  return t === "up" ? "text-ok" : t === "down" ? "text-bad" : "text-muted";
}

export function arrowOf(t: Tone): string {
  return t === "up" ? "▲" : t === "down" ? "▼" : "–";
}

/** "+0.183 SOL" / "-0.071 SOL" / "0.000 SOL". */
export function signedSol(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${Math.abs(v).toFixed(digits)} SOL`;
}

/** "+8.7%" / "-4.2%" from a fraction (0.087). */
export function signedPct(frac: number | null | undefined, digits = 1): string {
  if (frac == null || !Number.isFinite(frac)) return "—";
  const pct = frac * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

/** Plain SOL amount without sign: "0.150 SOL". */
export function plainSol(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)} SOL`;
}

/**
 * "A$42.50" (or "-A$3.10"). Locale-aware, two decimals.
 *
 * M01: a NEVER-FETCHED rate is a hardcoded guess, so converting with it
 * produces a number with no meaning — say so instead of printing "A$0.00",
 * which reads as a real zero. A merely STALE rate was real once, so show it
 * and mark it. Same rule as solToAudDisplay; this is the other render path,
 * and it was missed when that one was fixed.
 */
export function aud(
  sol: number | null | undefined,
  solAud: number,
  freshness?: { stale?: boolean; fallback?: boolean },
): string {
  if (sol == null || !Number.isFinite(sol) || !Number.isFinite(solAud)) return "—";
  if (freshness?.fallback) return "A$ rate unavailable";
  const v = sol * solAud;
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const text = `${v < 0 ? "-" : ""}A$${abs}`;
  return freshness?.stale ? `${text} (stale rate)` : text;
}

/** "$12.4K" / "$1.2M" / "$830". */
export function mcap(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return "—";
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

/** Age since an ISO time: "42s", "7m", "1h 12m". */
export function age(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function shortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/** Human time "12:04:07" from ISO/ms. */
export function clock(iso: string | number): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Local date + second-precision time for trade audit details. */
export function dateTime(iso: string | number | null | undefined): string {
  if (iso == null) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The activity log stores machine-ish messages ("Opened 0.03 SOL @ v=3116.947…",
 * "Closed sl · PnL -0.0052757…"). Strip the internals so the operator reads
 * plain words; the P&L is rendered separately from the numeric field.
 */
const CLOSE_REASON_WORDS: Array<[RegExp, string]> = [
  [/\bmanual_auto_sell_all\b/g, "sold via Sell all"],
  [/\bmanual(_sell)?\b/g, "sold manually"],
  [/\bsession_ended\b/g, "session ended"],
  [/\bworker_restart\b/g, "worker restarted"],
  [/\bstagnation\b/g, "no momentum (stagnation cut)"],
  [/\bsl\b/g, "stop-loss"],
  [/\btp1\b/g, "partial take-profit"],
  [/\btp\b/g, "take-profit"],
  [/\btrail\b/g, "trailing stop"],
  [/\btimeout\b/g, "max hold reached"],
];

export function cleanLogMessage(msg: string): string {
  let out = msg
    // The kind label already says OPENED / CLOSED; do not say it twice.
    .replace(/^\s*(opened|closed)\b\s*/i, "")
    .replace(/\s*@\s*v=[\d.eE+-]+/g, "")
    .replace(/\s*[·|]\s*PnL\s*[-+]?[\d.eE+-]+/gi, "");
  for (const [re, words] of CLOSE_REASON_WORDS) out = out.replace(re, words);
  // Anything still snake_cased is a machine reason we have no words for yet.
  return out.replace(/\b([a-z]+)_([a-z_]+)\b/g, (m) => m.replace(/_/g, " ")).replace(/\s{2,}/g, " ").trim();
}

/** "stop-loss", "take-profit", "sold via Sell all", ... from a stored close reason. */
export function closeReasonWords(reason: string | null | undefined): string {
  if (!reason) return "closed";
  let out = reason;
  for (const [re, words] of CLOSE_REASON_WORDS) out = out.replace(re, words);
  return out.replace(/_/g, " ");
}

/** "4m 12s" between two ISO times; "—" if either is missing. */
export function heldFor(openedAt: string | null | undefined, closedAt: string | null | undefined): string {
  if (!openedAt || !closedAt) return "—";
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Plain words for the error codes the trade routes return. */
export function tradeErrorMessage(code: string | null | undefined): string {
  const c = (code ?? "").toLowerCase();
  if (!c) return "The request was not accepted.";
  if (c === "no_price" || c === "pump_fun_lookup_failed") return "No live price for this coin right now. Try again in a moment, or use Sell all.";
  if (c === "live_disabled") return "Live execution is off.";
  if (c === "timeout_waiting_for_worker") return "The worker did not answer in time. Check it is running, then try again.";
  if (c.includes("halt")) return "Trading is paused by the circuit breaker.";
  return c.replace(/_/g, " ");
}
