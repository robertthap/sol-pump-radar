/**
 * Three-gate scoring (Luo et al. WWW '26, §5.1.3 + Fig. 6).
 *
 * The paper splits copy-trading judgement into three specialised "agents":
 *   - Wallet agent  → "is this wallet's next trade likely profitable?"
 *   - Coin agent    → "is the meme coin a good investment opportunity?"
 *   - Timing agent  → "is now a suitable entry timing?"
 *
 * They use few-shot CoT prompted LLMs. We reproduce the *structured pass/fail
 * gate* portion deterministically — the same conditions the prompts encode
 * (Tab. 1 / Listings 1–6) without needing an external LLM. Each gate returns
 * a confidence in [0,1] with a list of human-readable reasons. The aggregate
 * is a uniformly-weighted convex combination (paper trains weights on a
 * validation set; we default to equal weights and let the learner adjust).
 */

import type { MintFlags } from "@/lib/db/repos/bots";

export type WalletStat = {
  tStat: number | null;
  avgReturn: number | null;
  stdReturn: number | null;
  tradeCount: number | null;
  isBumpBot: boolean | null;
  sniperRate: number | null;
  bundleRate: number | null;
};

export type CoinSignals = {
  flags: MintFlags | null;
  gradScore: number;
  rugScore: number;
  curveVelocity5m: number | null;
  buys5m: number | null;
  sells5m: number | null;
  buyVol5m: number | null;
  sellVol5m: number | null;
  uniqueBuyers5m: number | null;
  /** Profit mode: lower bar (default 0.55). */
  minGradScore?: number;
  maxRugScore?: number;
};

export type TimingSignals = {
  ageSeconds: number | null;
  vSol: number | null;
  sizeSol: number;
  ageSecondsP25?: number;
  ageSecondsP75?: number;
  vSolP25?: number;
};

export type GateResult = {
  pass: boolean;
  confidence: number;
  reasons: string[];
};

export function walletGate(buyers: WalletStat[]): GateResult {
  const reasons: string[] = [];
  if (buyers.length === 0) {
    return { pass: false, confidence: 0.3, reasons: ["no recent buyers profiled"] };
  }
  // Drop wallets we already know are bump bots — paper §4.3.3.
  const cleaned = buyers.filter((b) => !b.isBumpBot);
  if (cleaned.length === 0) {
    return { pass: false, confidence: 0, reasons: ["all recent buyers flagged bump-bot"] };
  }

  const known = cleaned.filter((b) => b.tradeCount && b.tradeCount > 5);
  if (known.length === 0) {
    // Few-shot CoT default: lean negative when no experience signal at all.
    return {
      pass: false,
      confidence: 0.35,
      reasons: ["no recent buyer has prior trade history"],
    };
  }

  // Per the paper's "Statistical Significance" gate (Listing 1): t-stat > 1.645
  const significantBuyers = known.filter((b) => (b.tStat ?? 0) > 1.645);
  // Profitability gate: avg_return > 0
  const profitableBuyers = known.filter((b) => (b.avgReturn ?? 0) > 0);
  // Risk profile: std < 1.0
  const riskOk = known.filter((b) => (b.stdReturn ?? 0) > 0 && (b.stdReturn ?? 0) < 1.0);

  const sigShare = significantBuyers.length / known.length;
  const profShare = profitableBuyers.length / known.length;
  const riskShare = riskOk.length / known.length;

  reasons.push(
    `${significantBuyers.length}/${known.length} buyers t-stat>1.645`,
    `${profitableBuyers.length}/${known.length} buyers profitable on average`,
  );

  // Bundle/sniper-heavy buyer pool is a red flag (paper §4.2.1) — penalise.
  const bundleHeavy = known.filter((b) => (b.bundleRate ?? 0) > 0.4).length;
  const sniperHeavy = known.filter((b) => (b.sniperRate ?? 0) > 0.6).length;
  if (bundleHeavy > 0) reasons.push(`${bundleHeavy} buyers freq-bundle`);
  if (sniperHeavy > 0) reasons.push(`${sniperHeavy} buyers freq-sniper`);

  const conf = clamp01(
    0.4 * sigShare +
      0.4 * profShare +
      0.2 * riskShare -
      0.15 * (bundleHeavy / known.length) -
      0.1 * (sniperHeavy / known.length),
  );
  // Pass when meaningful smart-money cohort: ≥2 significant buyers OR strong majority profitable.
  const pass =
    significantBuyers.length >= 2 || (significantBuyers.length >= 1 && profShare >= 0.67);
  return { pass, confidence: conf, reasons };
}

export function coinGate(c: CoinSignals): GateResult {
  const reasons: string[] = [];

  // Required check 1 — Bundle Bot must be False (Alg. 1, Tab. 1)
  if (c.flags?.hasBundle) {
    return {
      pass: false,
      confidence: 0,
      reasons: [`bundle bot detected (${c.flags.bundleWalletCount} wallets in launch slot)`],
    };
  }
  // Required check 2 — Mechanical uptrend rejected (§4.3.5)
  if (c.flags?.mechanicalUptrend) {
    return {
      pass: false,
      confidence: 0.05,
      reasons: ["mechanical uptrend (gradual-bundle signature)"],
    };
  }

  // Auxiliary check — Sniper bot reduces confidence but not auto-reject (Listing 4)
  let snipPenalty = 0;
  if (c.flags?.hasSniper) {
    snipPenalty = Math.min(0.4, 0.1 + 0.05 * c.flags.sniperWalletCount);
    reasons.push(`sniper bot (${c.flags.sniperWalletCount} wallets)`);
  }

  // Bump bot weakly supportive per paper Fig. 4c — improves visibility without
  // affecting our profit much. We treat as +0 confidence (neutral).
  if (c.flags?.hasBumpBot) {
    reasons.push(`bump bot (${c.flags.bumpWalletCount} wallets)`);
  }

  // Organic flow proxy — buyers > sellers and decent diversity
  const flowOk = (c.buys5m ?? 0) > (c.sells5m ?? 0) && (c.uniqueBuyers5m ?? 0) >= 4;
  if (flowOk) reasons.push(`organic flow (${c.uniqueBuyers5m} unique buyers, ${c.buys5m}b/${c.sells5m}s)`);

  // Combine module scores — high grad + low rug = good (clamps already in [0,1])
  const moduleStrength = clamp01(c.gradScore - c.rugScore);

  const conf = clamp01(
    0.55 * moduleStrength +
      0.25 * (flowOk ? 1 : 0.3) -
      snipPenalty,
  );
  const pass =
    !c.flags?.hasBundle &&
    !c.flags?.mechanicalUptrend &&
    c.gradScore >= (c.minGradScore ?? 0.55) &&
    c.rugScore <= (c.maxRugScore ?? 0.35);
  reasons.push(`grad=${c.gradScore.toFixed(2)} rug=${c.rugScore.toFixed(2)}`);
  return { pass, confidence: conf, reasons };
}

export function timingGate(t: TimingSignals): GateResult {
  const reasons: string[] = [];
  const ageP25 = t.ageSecondsP25 ?? 60;
  const ageP75 = t.ageSecondsP75 ?? 600;
  const vSolP25 = t.vSolP25 ?? 12;

  // Must be past the sniper window (≥ 5 blocks ≈ 2s, but paper effectively
  // wants > 25th percentile of training set).
  const ageOk = (t.ageSeconds ?? 0) >= ageP25 && (t.ageSeconds ?? 0) <= ageP75;
  if (ageOk) {
    reasons.push(`age ${t.ageSeconds}s in [${ageP25},${ageP75}]`);
  } else {
    reasons.push(
      (t.ageSeconds ?? 0) < ageP25
        ? `too early (${t.ageSeconds}s < ${ageP25}s sniper window)`
        : `too late (${t.ageSeconds}s > ${ageP75}s)`,
    );
  }

  const liquidityOk = (t.vSol ?? 0) >= vSolP25;
  if (!liquidityOk) reasons.push(`thin liquidity vSol=${(t.vSol ?? 0).toFixed(1)}`);

  // Trade size sanity vs liquidity (price impact < 5%).
  const impact = t.vSol && t.vSol > 0 ? t.sizeSol / t.vSol : Infinity;
  const sizeOk = impact < 0.05;
  if (!sizeOk) reasons.push(`size ${t.sizeSol} too large vs vSol ${(t.vSol ?? 0).toFixed(1)}`);

  const pass = ageOk && liquidityOk && sizeOk;
  const conf = clamp01(
    (ageOk ? 0.5 : 0.15) + (liquidityOk ? 0.3 : 0) + (sizeOk ? 0.2 : 0),
  );
  return { pass, confidence: conf, reasons };
}

export type AggregateGate = {
  pass: boolean;
  confidence: number;
  wallet: GateResult;
  coin: GateResult;
  timing: GateResult;
  reasons: string[];
};

export function aggregateGates(input: {
  wallet: GateResult;
  coin: GateResult;
  timing: GateResult;
  weights?: { wallet: number; coin: number; timing: number };
}): AggregateGate {
  const w = input.weights ?? { wallet: 0.4, coin: 0.4, timing: 0.2 };
  const conf = clamp01(
    w.wallet * input.wallet.confidence +
      w.coin * input.coin.confidence +
      w.timing * input.timing.confidence,
  );
  const pass = input.coin.pass && input.wallet.pass && input.timing.pass;
  const reasons: string[] = [];
  if (!input.coin.pass) reasons.push(`coin gate failed: ${input.coin.reasons.join(" / ")}`);
  if (!input.wallet.pass) reasons.push(`wallet gate failed: ${input.wallet.reasons.join(" / ")}`);
  if (!input.timing.pass) reasons.push(`timing gate failed: ${input.timing.reasons.join(" / ")}`);
  return { pass, confidence: conf, wallet: input.wallet, coin: input.coin, timing: input.timing, reasons };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
