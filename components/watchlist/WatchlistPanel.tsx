"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";

/**
 * Operator-supplied "smart money" wallets.
 *
 * Two things this panel must do that a plain CRUD list would not:
 *
 * 1. Reject a wrong-chain address loudly. Pasting Ethereum addresses into a
 *    Solana system is an easy mistake, and one that silently produces a
 *    strategy which simply never fires.
 * 2. Show what OUR OWN data says about each wallet, next to the operator's
 *    judgement, without gating on it. Our scoring cannot currently validate
 *    these wallets - PUMPSWAP_INGEST is off, so post-graduation profit-taking
 *    is invisible and reads as a total loss. Presenting our verdict as truth
 *    would be worse than showing nothing.
 */

type Profile = {
  avgReturn: number | null;
  tStat: number | null;
  closedMints: number;
  distinctMints: number;
  bundleRate: number | null;
  qualifies: boolean;
};

type Watched = {
  wallet: string;
  label: string | null;
  note: string | null;
  active: boolean;
  addedAt: string;
  profile: Profile | null;
};

type Rejected = { input: string; reason: string };

function short(w: string) {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

/** Plain language for the profile, with the sample size that earns it. */
function verdict(p: Profile | null): { text: string; cls: string } {
  if (!p) return { text: "no data - we have never seen this wallet trade", cls: "text-muted" };
  const n = p.closedMints;
  if (n === 0) {
    const b = p.distinctMints;
    return { text: `${b} ${b === 1 ? "buy" : "buys"}, no exit we can see`, cls: "text-muted" };
  }
  const ret = p.avgReturn == null ? "—" : `${(p.avgReturn * 100).toFixed(0)}%`;
  const t = p.tStat == null ? "—" : p.tStat.toFixed(1);
  const sig = p.tStat != null && Math.abs(p.tStat) >= 1.645;
  if (p.qualifies) return { text: `${ret} avg over ${n} exits (t ${t})`, cls: "text-ok" };
  if (!sig) return { text: `${ret} avg over ${n} exits - not significant (t ${t})`, cls: "text-muted" };
  return { text: `${ret} avg over ${n} exits (t ${t})`, cls: "text-bad" };
}

export function WatchlistPanel() {
  const [wallets, setWallets] = useState<Watched[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings/watchlist", { cache: "no-store" });
      const j = (await r.json()) as { wallets?: Watched[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `http_${r.status}`);
      setWallets(j.wallets ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWallets([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (busy || !input.trim()) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const r = await fetch("/api/settings/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses: input }),
      });
      const j = (await r.json()) as {
        added?: number;
        reactivated?: number;
        duplicates?: string[];
        rejected?: Rejected[];
        wallets?: Watched[];
        error?: string;
      };
      setRejected(j.rejected ?? []);
      if (!r.ok) {
        setError(j.error ?? `http_${r.status}`);
        return;
      }
      const parts = [`${j.added ?? 0} added`];
      if (j.reactivated) parts.push(`${j.reactivated} re-activated`);
      if (j.duplicates?.length) parts.push(`${j.duplicates.length} duplicate`);
      setMessage(parts.join(", "));
      setInput("");
      if (j.wallets) setWallets(j.wallets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(wallet: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/settings/watchlist?wallet=${encodeURIComponent(wallet)}`, { method: "DELETE" });
      const j = (await r.json()) as { wallets?: Watched[] };
      if (j.wallets) setWallets(j.wallets);
    } finally {
      setBusy(false);
    }
  }

  const profiled = wallets?.filter((w) => w.profile != null).length ?? 0;

  return (
    <section className="card p-4" aria-labelledby="watchlist-title">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="watchlist-title" className="text-xs font-semibold uppercase tracking-wider text-muted">
          Smart money wallets
        </h2>
        {wallets && (
          <span className="text-xs tabular-nums text-muted">
            {wallets.length} followed &middot; {profiled} with a profile
          </span>
        )}
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        Wallets you want the bot to follow. A buy from one of these counts as a strong entry signal for the{" "}
        <span className="text-fg">Smart Money</span> preset.
      </p>

      <div className="mb-3 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-xs leading-relaxed text-muted">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
        <span>
          Our own scoring cannot judge these wallets yet. Every trade we ingest is a bonding-curve trade, so a wallet
          that takes profit <em>after</em> a coin graduates looks to us like it bought and never sold &mdash; booked as
          &minus;100%. Treat the numbers below as a note on our coverage, not a verdict on the wallet.
        </span>
      </div>

      <label htmlFor="watchlist-input" className="sr-only">
        Solana wallet addresses
      </label>
      <textarea
        id="watchlist-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder="Paste Solana addresses - one per line, or comma separated"
        className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy || !input.trim()}
          className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Add wallets
        </button>
        {message && <span className="text-xs text-ok">{message}</span>}
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>

      {rejected.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label="Rejected addresses">
          {rejected.map((r) => (
            <li key={r.input} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <code className="font-mono text-bad">
                {r.input.length > 20 ? `${r.input.slice(0, 20)}…` : r.input}
              </code>
              <span className="text-muted">{r.reason}</span>
            </li>
          ))}
        </ul>
      )}

      {wallets == null ? (
        <div className="mt-3 h-16 animate-pulse rounded-lg bg-bg" />
      ) : wallets.length === 0 ? (
        <p className="mt-3 text-xs text-muted">No wallets followed yet.</p>
      ) : (
        <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1">
          {wallets.map((w) => {
            const v = verdict(w.profile);
            const bundled = w.profile?.bundleRate != null && w.profile.bundleRate >= 0.9;
            return (
              <li
                key={w.wallet}
                className="flex items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <code className="font-mono text-fg" title={w.wallet}>
                      {short(w.wallet)}
                    </code>
                    {w.profile?.qualifies && (
                      <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[10px] font-semibold text-ok">
                        passes our bar
                      </span>
                    )}
                    {bundled && (
                      <span
                        className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn"
                        title="Nearly every trade we saw was in a bundle - often a coordinated ring rather than an edge"
                      >
                        bundled
                      </span>
                    )}
                  </div>
                  <div className={`mt-0.5 truncate tabular-nums ${v.cls}`}>{v.text}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(w.wallet)}
                  disabled={busy}
                  aria-label={`Stop following ${w.wallet}`}
                  title="Stop following"
                  className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-panel2 hover:text-bad disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
