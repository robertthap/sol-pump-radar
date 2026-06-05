/**
 * Copy-trade safety analysis (pure, web-safe — no DB/IO).
 *
 * Given a wallet's closed-trade profile (from wallet_profiles), produce a verdict
 * on whether it looks safe to copy-trade: a statistically proven, organic edge vs
 * a bot / coordinated ring / unproven wallet. Heuristic + transparent (every
 * verdict lists the reasons), matching the rest of the system's debuggable design.
 */

export type WalletProfileInput = {
  wallet: string;
  tradeCount: number;
  distinctMints: number;
  closedMints: number;
  avgReturn: number | null; // fraction, e.g. 0.27 = +27%
  tStat: number | null; // significance of avg return > 0
  last5Return: number | null;
  last10Return: number | null;
  isBumpBot: boolean;
  sniperRate: number | null; // 0..1
  bundleRate: number | null; // 0..1
  clusterKind: string | null; // "bundle_ring" | "sniper_ring" | "co_buy" | null
  clusterMembers: number | null;
  lastSeen: string | null;
};

export type CopyTradeVerdict = "safe" | "caution" | "avoid" | "unknown";

export type CopyTradeAnalysis = {
  verdict: CopyTradeVerdict;
  score: number; // 0..100 confidence that copy-trading this wallet is sound
  headline: string;
  positives: string[];
  negatives: string[];
};

function pct(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function analyzeCopyTradeSafety(p: WalletProfileInput | null): CopyTradeAnalysis {
  if (!p || (p.closedMints ?? 0) < 1) {
    return {
      verdict: "unknown",
      score: 0,
      headline: "Not enough history — we have no closed trades for this wallet yet.",
      positives: [],
      negatives: ["No closed-trade record in our data, so its edge can't be measured."],
    };
  }

  const positives: string[] = [];
  const negatives: string[] = [];
  const tStat = p.tStat ?? 0;
  const avg = p.avgReturn ?? 0;
  const sniper = p.sniperRate ?? 0;
  const bundle = p.bundleRate ?? 0;
  const ring = p.clusterKind === "bundle_ring" || p.clusterKind === "sniper_ring";

  // ── Hard disqualifiers (manipulative / non-organic) ──────────────────
  if (p.isBumpBot) {
    negatives.push("Flagged as a bump/spam bot — its trades are volume manufacturing, not alpha.");
  }
  if (p.clusterKind === "bundle_ring") {
    negatives.push(
      `Member of a bundle ring (${p.clusterMembers ?? "?"} wallets) — coordinated launch-block buyer, not organic edge.`,
    );
  } else if (p.clusterKind === "sniper_ring") {
    negatives.push(
      `Member of a sniper ring (${p.clusterMembers ?? "?"} wallets) — coordinated sniping, hard to copy and often manipulative.`,
    );
  } else if (p.clusterKind === "co_buy") {
    negatives.push("Repeatedly buys alongside the same wallets (co-buy cluster) — may be coordinated.");
  }
  if (sniper > 0.6) negatives.push(`Snipes ${(sniper * 100).toFixed(0)}% of entries — you can't realistically match that speed.`);
  if (bundle > 0.4) negatives.push(`In launch bundles ${(bundle * 100).toFixed(0)}% of the time — bundled fills you can't copy.`);

  // ── Edge signals ─────────────────────────────────────────────────────
  if (tStat >= 2.0) positives.push(`Strong statistical edge (t-stat ${tStat.toFixed(2)} ≫ 1.65).`);
  else if (tStat >= 1.645) positives.push(`Statistically significant edge (t-stat ${tStat.toFixed(2)} > 1.65).`);
  else if (tStat >= 1.0) negatives.push(`Edge is weak / not yet significant (t-stat ${tStat.toFixed(2)}).`);
  else negatives.push(`No statistical edge (t-stat ${tStat.toFixed(2)}).`);

  if (avg > 0) positives.push(`Average closed return ${pct(p.avgReturn)} across ${p.closedMints} coins.`);
  else negatives.push(`Average closed return is negative (${pct(p.avgReturn)}).`);

  if ((p.last5Return ?? 0) > 0) positives.push(`Recent form positive (last 5: ${pct(p.last5Return)}).`);
  else if (p.last5Return != null && p.last5Return < 0) negatives.push(`Recent form negative (last 5: ${pct(p.last5Return)}).`);

  if (p.closedMints >= 20) positives.push(`Large sample (${p.closedMints} closed coins) — the stats are trustworthy.`);
  else if (p.closedMints >= 8) positives.push(`Decent sample (${p.closedMints} closed coins).`);
  else negatives.push(`Small sample (${p.closedMints} closed coins) — treat the numbers as provisional.`);

  // ── Score ────────────────────────────────────────────────────────────
  let score = 50;
  score += clamp(tStat, -2, 4) * 12;
  score += (avg > 0 ? 1 : -1) * Math.min(Math.abs(avg) * 100, 18);
  score += (p.last5Return ?? 0) > 0 ? 6 : (p.last5Return ?? 0) < 0 ? -6 : 0;
  score += p.closedMints >= 20 ? 12 : p.closedMints >= 8 ? 5 : p.closedMints >= 3 ? 0 : -18;
  if (sniper > 0.6) score -= 15;
  if (bundle > 0.4) score -= 20;
  if (p.isBumpBot) score = Math.min(score, 6);
  if (ring) score = Math.min(score, 12);
  score = Math.round(clamp(score, 0, 100));

  // ── Verdict ──────────────────────────────────────────────────────────
  let verdict: CopyTradeVerdict;
  let headline: string;
  if (p.isBumpBot || ring) {
    verdict = "avoid";
    headline = p.isBumpBot
      ? "Avoid — this is a bot, not a trader."
      : "Avoid — coordinated ring wallet, not organic alpha.";
  } else if (p.closedMints < 3) {
    verdict = "unknown";
    headline = "Too few closed trades to judge — not enough evidence yet.";
  } else if (tStat >= 1.645 && avg > 0 && sniper <= 0.6 && bundle <= 0.4 && p.closedMints >= 5) {
    verdict = "safe";
    headline = "Looks copy-trade worthy — a statistically proven, organic edge.";
  } else if (tStat >= 1.0 && avg > 0) {
    verdict = "caution";
    headline = "Promising but unproven — copy a small size and watch it.";
  } else {
    verdict = "avoid";
    headline = "No proven edge — copying this wallet isn't justified by the data.";
  }

  return { verdict, score, headline, positives, negatives };
}
