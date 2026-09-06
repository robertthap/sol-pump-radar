import { Solana58 } from "@/lib/shared/types";

/**
 * Parse a pasted block of wallet addresses into accepted / rejected sets.
 *
 * Pure and standalone so the rejection reasons can be unit-tested without a
 * database. The reasons matter more than the parsing: the operator's first
 * attempt at this list was 20 Ethereum addresses, which a permissive parser
 * would have stored happily and then never matched against anything, looking
 * for all the world like "the strategy just never triggers". A wrong-chain
 * address must fail loudly at the point of entry, naming the problem.
 */

export type RejectedWallet = { input: string; reason: string };

export type ParsedWatchlistInput = {
  /** Valid, deduped, in first-seen order. */
  accepted: string[];
  rejected: RejectedWallet[];
  /** Inputs dropped as exact repeats of an earlier accepted address. */
  duplicates: string[];
};

/** Ethereum-style hex address — the mistake worth naming explicitly. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Base58 excludes 0, O, I and l precisely so they cannot be confused. */
const BASE58_CONFUSABLE = /[0OIl]/;

const MAX_ADDRESSES = 500;

function reasonFor(raw: string): string | null {
  if (EVM_ADDRESS.test(raw)) {
    return "that is an Ethereum address; this system trades Solana";
  }
  if (raw.startsWith("0x")) {
    return "starts with 0x - this system trades Solana, not an EVM chain";
  }
  if (Solana58.safeParse(raw).success) return null;

  if (raw.length < 32) return `too short (${raw.length} chars; a Solana address is 32-44)`;
  if (raw.length > 64) return `too long (${raw.length} chars; a Solana address is 32-44)`;
  const bad = raw.match(BASE58_CONFUSABLE);
  if (bad) {
    return `contains "${bad[0]}", which base58 does not use - check for a transcription slip`;
  }
  return "not a valid base58 Solana address";
}

/**
 * Accepts anything separated by commas, whitespace or newlines, which is how
 * addresses actually arrive (pasted from a spreadsheet, a chat message, or a
 * block explorer, one per line or comma-joined).
 */
export function parseWatchlistInput(input: string): ParsedWatchlistInput {
  const accepted: string[] = [];
  const rejected: RejectedWallet[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  const tokens = input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_ADDRESSES);

  for (const raw of tokens) {
    const reason = reasonFor(raw);
    if (reason) {
      rejected.push({ input: raw, reason });
      continue;
    }
    if (seen.has(raw)) {
      duplicates.push(raw);
      continue;
    }
    seen.add(raw);
    accepted.push(raw);
  }

  return { accepted, rejected, duplicates };
}
