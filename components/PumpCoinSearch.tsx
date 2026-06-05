"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { setSelectedMint } from "@/lib/ui/store";
import { shortAddr } from "@/lib/ui/format";

type Coin = {
  mint: string;
  name: string | null;
  symbol: string | null;
  vSol: number | null;
};

export function PumpCoinSearch({
  compact,
  onSelectMint,
}: {
  compact?: boolean;
  onSelectMint?: (mint: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isMission = pathname === "/mission";
  const [mounted, setMounted] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Coin[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const goMint = useCallback(
    (mint: string) => {
      setSelectedMint(mint);
      if (onSelectMint) {
        onSelectMint(mint);
        setResults([]);
        return;
      }
      if (isMission) {
        setResults([]);
        return;
      }
      router.push(`/token/${mint}`);
    },
    [isMission, onSelectMint, router],
  );

  const search = useCallback(async () => {
    const term = q.trim();
    if (!term) return;
    setBusy(true);
    try {
      if (term.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(term)) {
        goMint(term);
        return;
      }
      const r = await fetch(`/api/pump/search?q=${encodeURIComponent(term)}&limit=20`);
      if (!r.ok) return;
      const j = (await r.json()) as { coins: Coin[] };
      setResults(j.coins ?? []);
    } finally {
      setBusy(false);
    }
  }, [q, goMint]);

  if (!mounted) {
    return <div className={compact ? "mb-3 h-9" : "mb-4 h-10"} aria-hidden />;
  }

  return (
    <div className={compact ? "mb-0 w-full min-w-0 flex-1 sm:min-w-[12rem]" : "mb-4 w-full"}>
      <div className="flex w-full min-w-0 gap-2" suppressHydrationWarning>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search or paste mint"
          className="flex-1 rounded border border-border bg-panel px-3 py-2 text-sm"
          suppressHydrationWarning
        />
        <button type="button" className="btn btn-primary px-4" onClick={search} disabled={busy}>
          {busy ? "…" : "Go"}
        </button>
      </div>
      {results.length > 0 && (
        <div className="mt-2 card overflow-hidden">
          <table className="table-feed w-full text-xs">
            <tbody>
              {results.map((c) => (
                <tr key={c.mint} className="border-t border-border/40">
                  <td>
                    {isMission || onSelectMint ? (
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => goMint(c.mint)}
                      >
                        {c.symbol ?? shortAddr(c.mint, 4, 4)}
                      </button>
                    ) : (
                      <Link href={`/token/${c.mint}`} className="text-accent hover:underline">
                        {c.symbol ?? shortAddr(c.mint, 4, 4)}
                      </Link>
                    )}
                    {c.name && <span className="ml-2 text-muted">{c.name.slice(0, 40)}</span>}
                  </td>
                  <td className="text-right font-mono text-muted">
                    {c.vSol != null ? `${c.vSol.toFixed(1)} SOL` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
