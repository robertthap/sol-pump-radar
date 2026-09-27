"use client";

import { useState } from "react";
import { stageColorToken, stageLabel } from "@/lib/radar/layout";
import type { RadarSample, RadarSnapshot } from "@/lib/radar/snapshot";
import { RADAR_COLOR, STAGE_HELP } from "@/components/radar/stage-copy";
import { age, clock, shortMint, signedSol, toneClass, toneOf } from "@/components/ticker/format";

/**
 * What went through one stage: the coins themselves, newest first, with the score they carried and the worker's own
 * reason. Picking a coin shows that one arrival in full — the operator's "why did this one die?".
 */
type Props = {
  data: RadarSnapshot | null;
  stageId: string | null;
  pinned: boolean;
  coin: RadarSample | null;
  nowMs: number;
  onPickCoin: (s: RadarSample | null) => void;
  onUnpin: () => void;
};

export function StagePanel({ data, stageId, pinned, coin, nowMs, onPickCoin, onUnpin }: Props) {
  if (coin) return <CoinDetail coin={coin} nowMs={nowMs} onBack={() => onPickCoin(null)} />;

  const samples = stageId && data ? data.samples.filter((s) => idOf(s) === stageId) : [];
  const count = stageId && data ? countFor(data, stageId) : 0;

  return (
    <section className="card flex h-full flex-col overflow-hidden" aria-labelledby="stage-title">
      <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="stage-title" className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
          {stageId && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: RADAR_COLOR[stageColorToken(stageId)] }} aria-hidden="true" />}
          <span className="truncate">{stageId ? stageLabel(stageId) : "Stage"}</span>
        </h2>
        {stageId && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-sm tabular-nums text-fg">{count.toLocaleString("en-US")}</span>
            {pinned && (
              <button type="button" className="btn-ghost" onClick={onUnpin}>
                Unpin
              </button>
            )}
          </div>
        )}
      </div>

      {!stageId ? (
        <p className="px-3 py-6 text-center text-sm text-muted">
          Point at a stage in the flow to see the coins that went through it. Click one to keep it open.
        </p>
      ) : (
        <>
          <p className="border-b border-border px-3 py-2 text-xs leading-relaxed text-muted">{STAGE_HELP[stageId] ?? "A stage of the pipeline."}</p>
          {samples.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">No coins recorded here in this window.</p>
          ) : (
            <ol className="m-0 max-h-80 list-none overflow-y-auto p-0 text-xs">
              {samples.map((s) => (
                <li key={`${s.mint}-${s.created_at}`} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onPickCoin(s)}
                    className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-panel2"
                  >
                    <span className="font-mono text-fg">{shortMint(s.mint)}</span>
                    <span className="font-mono tabular-nums text-muted">{s.score != null ? s.score.toFixed(3) : "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{s.detail ?? ""}</span>
                    {s.pnl_sol != null && <span className={`tabular-nums ${toneClass(toneOf(s.pnl_sol))}`}>{signedSol(s.pnl_sol, 4)}</span>}
                    <span className="shrink-0 font-mono tabular-nums text-muted">{age(s.created_at, nowMs)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-auto border-t border-border px-3 py-2 text-[0.6875rem] text-muted">
            Newest first, up to 25 coins. Score is the confluence score (0–1).
          </p>
        </>
      )}
    </section>
  );
}

function CoinDetail({ coin, nowMs, onBack }: { coin: RadarSample; nowMs: number; onBack: () => void }) {
  const [copied, setCopied] = useState(false);
  const id = idOf(coin);
  const stopped = coin.stage === "rejected" || coin.stage === "skipped";

  async function copy() {
    try {
      await navigator.clipboard.writeText(coin.mint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard blocked: the full mint is on screen to copy by hand */
    }
  }

  return (
    <section className="card flex h-full flex-col overflow-hidden" aria-labelledby="coin-title">
      <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="coin-title" className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: RADAR_COLOR[stageColorToken(id)] }} aria-hidden="true" />
          <span className="truncate">{stopped ? `Stopped: ${stageLabel(id)}` : stageLabel(id)}</span>
        </h2>
        <button type="button" className="btn-ghost shrink-0" onClick={onBack}>
          Back
        </button>
      </div>

      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 text-xs">
        <dt className="text-muted">Coin</dt>
        <dd className="m-0 min-w-0 break-all font-mono text-fg">{coin.mint}</dd>

        <dt className="text-muted">When</dt>
        <dd className="m-0 font-mono tabular-nums text-fg">
          {clock(coin.created_at)} <span className="text-muted">({age(coin.created_at, nowMs)} ago)</span>
        </dd>

        <dt className="text-muted">Score</dt>
        <dd className="m-0 font-mono tabular-nums text-fg">{coin.score != null ? coin.score.toFixed(3) : "not scored"}</dd>

        {coin.detail && (
          <>
            <dt className="text-muted">{stopped ? "Reason" : "Detail"}</dt>
            <dd className="m-0 text-fg">{coin.detail}</dd>
          </>
        )}

        {coin.pnl_sol != null && (
          <>
            <dt className="text-muted">Result</dt>
            <dd className={`m-0 tabular-nums ${toneClass(toneOf(coin.pnl_sol))}`}>{signedSol(coin.pnl_sol, 4)}</dd>
          </>
        )}
      </dl>

      <p className="px-3 pb-3 text-xs leading-relaxed text-muted">{STAGE_HELP[id] ?? ""}</p>

      <div className="mt-auto flex flex-wrap gap-2 border-t border-border px-3 py-2">
        <button type="button" className="btn" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy mint"}
        </button>
        <a className="btn" href={`https://pump.fun/coin/${coin.mint}`} target="_blank" rel="noopener noreferrer">
          Open on pump.fun
        </a>
      </div>
    </section>
  );
}

function idOf(s: RadarSample): string {
  return s.sub_stage ? `${s.stage}::${s.sub_stage}` : s.stage;
}

/** Entry has no samples of its own: its coins live in the paper and live lanes. */
function countFor(data: RadarSnapshot, stageId: string): number {
  if (stageId === "entry") {
    return data.counts.filter((c) => c.stage === "entry").reduce((a, b) => a + b.count, 0);
  }
  const [stage, sub] = stageId.includes("::")
    ? [stageId.slice(0, stageId.indexOf("::")), stageId.slice(stageId.indexOf("::") + 2)]
    : [stageId, null];
  return data.counts.find((c) => c.stage === stage && c.sub_stage === sub)?.count ?? 0;
}
