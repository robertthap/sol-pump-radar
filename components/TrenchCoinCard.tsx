"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { shortAddr, relTime } from "@/lib/ui/format";
import { useTradingMode } from "@/components/TradingModeProvider";
import { flagClass } from "@/lib/market/flags";
import { tierClass } from "@/lib/signals/quality";
import type { MarketCoin, MarketCoinAnalysis } from "@/lib/market/types";
import { submitDemoTrade } from "@/lib/trade-client";

/** Normalize coin image URIs to a reliable IPFS gateway. cf-ipfs.com / cloudflare-ipfs.com
 *  no longer resolve (ERR_NAME_NOT_RESOLVED); rewrite them + ipfs:// to ipfs.io. */
function normalizeImg(uri: string | null): string | undefined {
  if (!uri) return undefined;
  const u = uri.trim();
  const cid = u.startsWith("ipfs://") ? u.slice("ipfs://".length) : null;
  if (cid) return `https://ipfs.io/ipfs/${cid}`;
  return u.replace(/https?:\/\/(?:cf-ipfs\.com|cloudflare-ipfs\.com)\/ipfs\//, "https://ipfs.io/ipfs/");
}

export type TrenchCoin = {
  mint: string;
  name: string | null;
  symbol: string | null;
  complete: boolean;
  vSol: number | null;
  usdMarketCap: number | null;
  createdAt: string | null;
  lastTradeAt: string | null;
  imageUri: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  creator: string | null;
  replyCount: number;
  bondingPct: number | null;
  analysis?: MarketCoinAnalysis;
};
function fmtMcap(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}

function fmtVol(vSol: number | null) {
  if (vSol == null) return "—";
  return `$${Math.round(vSol * 160)}`;
}

function ageShort(iso: string | null, now: number) {
  if (!iso || now <= 0) return "…";
  return relTime(iso, now);
}

function filterCoins(coins: TrenchCoin[], q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return coins;
  return coins.filter(
    (c) =>
      c.symbol?.toLowerCase().includes(needle) ||
      c.name?.toLowerCase().includes(needle) ||
      c.mint.toLowerCase().includes(needle),
  );
}

function SocialBtn({ href, label }: { href: string; label: string }) {
  return (
    <button
      type="button"
      className="trench-social"
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
    >
      {label}
    </button>
  );
}

export function TrenchCoinCard({
  coin,
  now,
  onSelectMint,
  active,
  showAnalysis,
}: {
  coin: TrenchCoin | MarketCoin;
  now: number;
  onSelectMint?: (mint: string, vSol?: number | null) => void;
  active?: boolean;
  showAnalysis?: boolean;
}) {  const router = useRouter();
  const { mode, needsSelection } = useTradingMode();
  const [busy, setBusy] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  function openCoin() {
    if (onSelectMint) onSelectMint(coin.mint, coin.vSol);
    else router.push(`/token/${coin.mint}`);
  }

  async function quickBuy(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    if (needsSelection || (mode !== "demo" && mode !== "real")) {
      // No wallet chosen this session — don't silently trade the demo account from a
      // browse view; send to the wallet chooser first.
      router.push("/");
      return;
    }
    setBusy(true);
    try {
      if (mode === "demo") {
        await submitDemoTrade({
          mint: coin.mint,
          sizeSol: 0.05,
          side: "buy",
          vSol: coin.vSol ?? undefined,
        });
      }
      openCoin();
    } finally {
      setBusy(false);
    }
  }

  const symbol = coin.symbol?.trim() || shortAddr(coin.mint, 4, 4);
  const pct = coin.bondingPct ?? 0;
  const a = showAnalysis ? coin.analysis : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      className={`trench-card cursor-pointer ${active ? "trench-card-active" : ""} ${
        a?.tradable ? "trench-card-tradable" : ""
      } ${a?.primaryFlag === "rug" || a?.primaryFlag === "avoid" ? "trench-card-avoid" : ""}`}
      onClick={openCoin}
      onKeyDown={(e) => e.key === "Enter" && openCoin()}
      title={a?.tradeableReason}
    >
      {a && (
        <div className="trench-analysis-row">
          <span className={`market-flag-pill ${flagClass(a.primaryFlag)}`}>{a.flagLabel}</span>
          {a.qualityScore > 0 && (
            <span className={`pill text-[9px] ${tierClass(a.qualityTier)}`}>Q{a.qualityScore}</span>
          )}
          {a.hasBundle && <span className="trench-risk-dot" title="Bundle">B</span>}
          {a.hasSniper && <span className="trench-risk-dot" title="Sniper">S</span>}
          {a.rugScore != null && a.rugScore >= 0.38 && (
            <span className="trench-risk-dot trench-risk-rug" title="Rug risk">
              R
            </span>
          )}
        </div>
      )}
      <div className="trench-card-top">
        <div className="trench-thumb">
          {coin.imageUri && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={normalizeImg(coin.imageUri)}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <span className="text-lg opacity-40">{symbol.slice(0, 1)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-fg">{symbol}</span>
            <span className="shrink-0 text-[10px] text-muted">
              {ageShort(coin.createdAt, now)}
            </span>
          </div>
          <p className="truncate text-[10px] text-muted">{coin.name ?? coin.mint.slice(0, 8)}</p>
          <p className="truncate font-mono text-[9px] text-muted/70">{coin.mint.slice(0, 6)}…pump</p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          {coin.twitter && <SocialBtn href={coin.twitter} label="X" />}
          {coin.telegram && <SocialBtn href={coin.telegram} label="TG" />}
          {coin.website && <SocialBtn href={coin.website} label="↗" />}
        </div>
      </div>

      <div className="trench-metrics">
        <span>
          V <b>{fmtVol(coin.vSol)}</b>
        </span>
        <span>
          MC{" "}
          <b
            className={
              coin.usdMarketCap != null && coin.usdMarketCap >= 100_000 ? "text-warn" : ""
            }
          >
            {fmtMcap(coin.usdMarketCap)}
          </b>
        </span>
        <span>
          TX <b>{coin.replyCount > 0 ? coin.replyCount : "—"}</b>
        </span>
      </div>

      {!coin.complete && (
        <div className="trench-bond-bar">
          <div className="trench-bond-fill" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}

      <div className="trench-card-foot">
        <span className="text-[9px] text-muted">
          {coin.creator ? shortAddr(coin.creator, 4, 4) : "—"}
        </span>
        <button type="button" className="trench-buy" onClick={quickBuy} disabled={busy}>
          {busy ? "…" : "⚡ Buy"}
        </button>
      </div>
    </div>
  );
}

export function TrenchColumn({
  title,
  coins,
  now,
  emptyLabel,
  onSelectMint,
  activeMint,
  compact,
  showAnalysis,
}: {
  title: string;
  coins: TrenchCoin[];
  now: number;
  emptyLabel: string;
  onSelectMint?: (mint: string, vSol?: number | null) => void;
  activeMint?: string | null;
  compact?: boolean;
  showAnalysis?: boolean;
}) {
  const [q, setQ] = useState("");
  const filtered = filterCoins(coins, q);

  return (
    <section className={`trench-col ${compact ? "trench-col-compact" : ""}`}>
      <header className="trench-col-head">
        <h2 className="trench-col-title">{title}</h2>
        <span className="text-[10px] text-muted">{filtered.length}</span>
      </header>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search…"
        className="trench-search"
      />
      <div className="trench-scroll">
        {filtered.length === 0 ? (
          <div className="trench-empty">{emptyLabel}</div>
        ) : (
          filtered.map((c) => (
            <TrenchCoinCard
              key={c.mint}
              coin={c}
              now={now}
              onSelectMint={onSelectMint}
              active={activeMint === c.mint}
              showAnalysis={showAnalysis}
            />
          ))
        )}
      </div>
    </section>
  );
}
