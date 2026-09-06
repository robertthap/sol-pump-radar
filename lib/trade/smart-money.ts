import { analyzeCopyTradeSafety, type WalletProfileInput } from "@/lib/wallet/copy-trade-safety";

/**
 * "Is quality money buying this coin?" — pure, no DB/IO.
 *
 * Two independent sources, deliberately never merged into one pool:
 *
 *   watchlist  — wallets the operator chose (wallet_watchlist)
 *   profiled   — wallets OUR statistics rate as having an edge (wallet_profiles)
 *
 * They are kept apart because they fail in opposite directions. Our statistics
 * cannot see post-graduation trading at all (PUMPSWAP_INGEST is off, so every
 * ingested event is a bonding-curve trade), which means a wallet that buys the
 * curve and takes profit on PumpSwap is booked as a total loss. Of the 23
 * wallets the operator supplied, zero clear our own bar. Pooling the two
 * sources would let that blind spot silently veto the operator's list.
 *
 * So: our safety check applies to OUR candidates, and the operator's list
 * stands on the operator's judgement. What our profiler thinks of a watched
 * wallet still travels in `reason`, so a bad call stays visible and debuggable
 * rather than being either hidden or silently enforced.
 *
 * KNOWN LIMITATION (the reason this is best-effort, and worth stating at the
 * call site): a watched wallet's post-graduation buys are invisible to us for
 * the same ingestion reason. Watchlist following is reliable BEFORE graduation
 * and blind after it. Turning on PUMPSWAP_INGEST is what would close that gap.
 */

export type SmartMoneyTier = "none" | "weak" | "strong";

/** A wallet seen buying the candidate mint, with whatever profile we hold. */
export type SmartMoneyCandidate = {
  wallet: string;
  /** Null when we have never profiled this wallet — common, and not disqualifying. */
  profile: WalletProfileInput | null;
  solAmount: number | null;
};

export type SmartMoneySignalInput = {
  /** Buyers that appear on the operator's watchlist. */
  watchlistBuyers: SmartMoneyCandidate[];
  /** Buyers our own scoring already qualified (fetchSmartMoneyBuyersForMint). */
  profiledBuyers: SmartMoneyCandidate[];
};

export type SmartMoneySignal = {
  tier: SmartMoneyTier;
  /** 0..1, monotone with tier. For logging and ranking, not for gating. */
  score: number;
  /** One human sentence — this is what makes "why didn't it buy?" answerable. */
  reason: string;
  /** Watchlist wallets counted toward the tier. */
  watchlistHits: string[];
  /** Profiled wallets counted, i.e. after the `avoid` filter. */
  profiledHits: string[];
  /** Profiled wallets dropped by the safety check, with why. */
  excluded: Array<{ wallet: string; reason: string }>;
};

function shortWallet(w: string): string {
  return `${w.slice(0, 4)}..${w.slice(-4)}`;
}

/** Does the tier clear the configured requirement? */
export function meetsSmartMoneyRequirement(tier: SmartMoneyTier, require: "off" | "weak" | "strong"): boolean {
  if (require === "off") return true;
  if (require === "weak") return tier === "weak" || tier === "strong";
  return tier === "strong";
}

export function smartMoneySignal(input: SmartMoneySignalInput): SmartMoneySignal {
  const excluded: Array<{ wallet: string; reason: string }> = [];

  // Our own candidates go through our own safety check. analyzeCopyTradeSafety
  // exists because a 278-wallet bundle ring can show a fake +180% edge; a wallet
  // it rates `avoid` is exactly that trap and must not be counted as an edge.
  const profiledHits: string[] = [];
  for (const c of input.profiledBuyers) {
    const a = analyzeCopyTradeSafety(c.profile);
    if (a.verdict === "avoid") {
      excluded.push({ wallet: c.wallet, reason: a.headline });
      continue;
    }
    profiledHits.push(c.wallet);
  }

  // The operator's list is not filtered by our verdict — see the module note.
  const watchlistHits = input.watchlistBuyers.map((c) => c.wallet);

  if (watchlistHits.length > 0) {
    const names = watchlistHits.slice(0, 3).map(shortWallet).join(", ");
    const more = watchlistHits.length > 3 ? ` +${watchlistHits.length - 3} more` : "";
    return {
      tier: "strong",
      score: 1,
      reason: `watched wallet buying: ${names}${more}`,
      watchlistHits,
      profiledHits,
      excluded,
    };
  }

  if (profiledHits.length >= 2) {
    return {
      tier: "strong",
      score: 0.8,
      reason: `${profiledHits.length} profiled wallets with edge buying: ${profiledHits.slice(0, 3).map(shortWallet).join(", ")}`,
      watchlistHits,
      profiledHits,
      excluded,
    };
  }

  if (profiledHits.length === 1) {
    return {
      tier: "weak",
      score: 0.5,
      reason: `1 profiled wallet with edge buying: ${shortWallet(profiledHits[0])}`,
      watchlistHits,
      profiledHits,
      excluded,
    };
  }

  // Saying WHY there is no signal matters as much as the tier: "nobody bought"
  // and "the only buyers were a bundle ring" are different problems.
  const reason =
    excluded.length > 0
      ? `no smart money (${excluded.length} buyer${excluded.length === 1 ? "" : "s"} excluded as unsafe to copy)`
      : "no watched or profiled wallet buying this mint";

  return { tier: "none", score: 0, reason, watchlistHits, profiledHits, excluded };
}
