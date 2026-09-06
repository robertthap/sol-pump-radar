import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { meetsSmartMoneyRequirement, smartMoneySignal, type SmartMoneyCandidate } from "@/lib/trade/smart-money";
import type { WalletProfileInput } from "@/lib/wallet/copy-trade-safety";

const W1 = "GijFWw4oNyh9ko3FaZforNsi3jk6wDovARpkKahPD4o5";
const W2 = "56S29mZ3wqvw8hATuUUFqKhGcSGYFASRRFNT38W8q7G3";
const W3 = "CEUA7zVoDRqRYoeHTP58UHU6TR8yvtVbeLrX1dppqoXJ";

function profile(over: Partial<WalletProfileInput> = {}): WalletProfileInput {
  // A wallet analyzeCopyTradeSafety is happy with: real sample, real edge,
  // organic (not sniping, not bundled, not in a ring).
  return {
    wallet: W1,
    tradeCount: 40,
    distinctMints: 20,
    closedMints: 18,
    avgReturn: 0.3,
    tStat: 3.2,
    last5Return: 0.2,
    last10Return: 0.25,
    isBumpBot: false,
    sniperRate: 0.05,
    bundleRate: 0.05,
    clusterKind: null,
    clusterMembers: null,
    lastSeen: new Date().toISOString(),
    ...over,
  };
}

function candidate(wallet: string, p: WalletProfileInput | null): SmartMoneyCandidate {
  return { wallet, profile: p, solAmount: 0.5 };
}

describe("smartMoneySignal", () => {
  it("is none when nobody of interest is buying", () => {
    const s = smartMoneySignal({ watchlistBuyers: [], profiledBuyers: [] });
    assert.equal(s.tier, "none");
    assert.equal(s.score, 0);
    assert.match(s.reason, /no watched or profiled wallet/);
  });

  it("a single watchlist hit is strong on its own", () => {
    const s = smartMoneySignal({ watchlistBuyers: [candidate(W1, null)], profiledBuyers: [] });
    assert.equal(s.tier, "strong");
    assert.equal(s.score, 1);
    assert.deepEqual(s.watchlistHits, [W1]);
    assert.match(s.reason, /watched wallet buying/);
  });

  // The operator's list is judgement we do not have the data to overrule: our
  // profiler cannot see post-graduation exits, so its verdict on these wallets
  // is not evidence. Filtering here would make the preset never fire.
  it("does not drop a watchlist hit our own profiler rates avoid", () => {
    const ring = profile({ wallet: W1, bundleRate: 1, clusterKind: "bundle_ring", clusterMembers: 278 });
    const s = smartMoneySignal({ watchlistBuyers: [candidate(W1, ring)], profiledBuyers: [] });
    assert.equal(s.tier, "strong", "operator judgement is not vetoed by our blind spot");
    assert.equal(s.excluded.length, 0);
  });

  it("two profiled buyers are strong", () => {
    const s = smartMoneySignal({
      watchlistBuyers: [],
      profiledBuyers: [candidate(W1, profile()), candidate(W2, profile({ wallet: W2 }))],
    });
    assert.equal(s.tier, "strong");
    assert.equal(s.profiledHits.length, 2);
  });

  it("one profiled buyer is weak, not strong", () => {
    const s = smartMoneySignal({ watchlistBuyers: [], profiledBuyers: [candidate(W1, profile())] });
    assert.equal(s.tier, "weak");
    assert.equal(s.score, 0.5);
  });

  // The trap analyzeCopyTradeSafety exists to catch: a coordinated ring whose
  // members all show a spectacular "edge" because they exit into each other.
  it("excludes a bundle-ring buyer from OUR side of the count", () => {
    const ring = profile({ wallet: W2, bundleRate: 1, clusterKind: "bundle_ring", clusterMembers: 278, avgReturn: 1.8 });
    const s = smartMoneySignal({
      watchlistBuyers: [],
      profiledBuyers: [candidate(W1, profile()), candidate(W2, ring)],
    });
    assert.equal(s.tier, "weak", "two buyers minus one excluded is one, i.e. weak not strong");
    assert.deepEqual(s.profiledHits, [W1]);
    assert.equal(s.excluded.length, 1);
    assert.equal(s.excluded[0].wallet, W2);
  });

  it("says WHY there is no signal when every buyer was excluded", () => {
    const ring = profile({ bundleRate: 1, clusterKind: "bundle_ring", clusterMembers: 278 });
    const s = smartMoneySignal({ watchlistBuyers: [], profiledBuyers: [candidate(W1, ring)] });
    assert.equal(s.tier, "none");
    assert.match(s.reason, /excluded as unsafe to copy/, "'nobody bought' and 'all buyers were a ring' differ");
  });

  it("a watchlist hit outranks any number of profiled buyers", () => {
    const s = smartMoneySignal({
      watchlistBuyers: [candidate(W3, null)],
      profiledBuyers: [candidate(W1, profile()), candidate(W2, profile({ wallet: W2 }))],
    });
    assert.equal(s.score, 1);
    assert.match(s.reason, /watched wallet/);
    assert.deepEqual(s.profiledHits, [W1, W2], "profiled hits are still reported, just not the headline");
  });

  it("names at most three wallets and counts the rest", () => {
    const many = [W1, W2, W3, "AJofLRzr9Hj6P86u2pQuxhLM12ZaMupRtxMDmyAJ18KN"].map((w) => candidate(w, null));
    const s = smartMoneySignal({ watchlistBuyers: many, profiledBuyers: [] });
    assert.match(s.reason, /\+1 more/);
    assert.equal(s.watchlistHits.length, 4);
  });
});

describe("meetsSmartMoneyRequirement", () => {
  it("off accepts every tier", () => {
    for (const t of ["none", "weak", "strong"] as const) {
      assert.equal(meetsSmartMoneyRequirement(t, "off"), true);
    }
  });

  it("weak accepts weak and strong but not none", () => {
    assert.equal(meetsSmartMoneyRequirement("none", "weak"), false);
    assert.equal(meetsSmartMoneyRequirement("weak", "weak"), true);
    assert.equal(meetsSmartMoneyRequirement("strong", "weak"), true);
  });

  it("strong accepts only strong", () => {
    assert.equal(meetsSmartMoneyRequirement("none", "strong"), false);
    assert.equal(meetsSmartMoneyRequirement("weak", "strong"), false);
    assert.equal(meetsSmartMoneyRequirement("strong", "strong"), true);
  });
});
