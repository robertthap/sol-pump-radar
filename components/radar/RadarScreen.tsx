"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { RADAR_WINDOWS, type RadarSample, type RadarSnapshot, type RadarWindow } from "@/lib/radar/snapshot";
import { RadarFlow } from "@/components/radar/RadarFlow";
import { RejectionTable } from "@/components/radar/RejectionTable";
import { StagePanel } from "@/components/radar/StagePanel";
import { RADAR_COLOR } from "@/components/radar/stage-copy";
import { age, signedSol, toneClass, toneOf } from "@/components/ticker/format";

/**
 * /radar — watch the worker think.
 *
 * One poll of /api/radar/snapshot every 2 s drives everything: the flow, the stage lists and the table. Nothing
 * here is decorative: every bar, stream and row is a stage the worker really has (lib/workers/auto-trader.ts).
 */
const POLL_MS = 2_000;
const WINDOW_LABEL: Record<RadarWindow, string> = { "1m": "1 min", "5m": "5 min", "15m": "15 min", "1h": "1 hour" };

export function RadarScreen() {
  const [windowKey, setWindowKey] = useState<RadarWindow>("5m");
  const [data, setData] = useState<RadarSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failures, setFailures] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [coin, setCoin] = useState<RadarSample | null>(null);
  const inflight = useRef(false);
  const windowRef = useRef<RadarWindow>(windowKey);
  windowRef.current = windowKey;

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const asked = windowRef.current;
    try {
      const r = await fetch(`/api/radar/snapshot?window=${asked}`, { cache: "no-store" });
      const j = (await r.json()) as RadarSnapshot & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error ?? `http_${r.status}`);
      // A window change mid-flight would otherwise paint the old window's numbers.
      if (asked === windowRef.current) {
        setData(j);
        setError(null);
        setFailures(0);
        setLastOkAt(Date.now());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFailures((n) => Math.min(4, n + 1));
    } finally {
      inflight.current = false;
      setNow(Date.now());
    }
  }, []);

  const pollMs = failures > 0 ? Math.min(15_000, POLL_MS * 2 ** failures) : POLL_MS;
  useVisibleInterval(load, pollMs, [load, windowKey]);
  useVisibleInterval(() => setNow(Date.now()), 1_000, []);

  const focusId = pinned ?? hovered;
  const totals = data?.totals;
  const bot = data?.bot;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-fg">Coin journey</h1>
          <p className="mt-0.5 text-xs text-muted">
            Every coin the worker sees, and exactly where it stops. Live from the worker&apos;s own stages.
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Time window">
          {(Object.keys(RADAR_WINDOWS) as RadarWindow[]).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={windowKey === k}
              onClick={() => {
                setWindowKey(k);
                setCoin(null);
              }}
              className={`tab ${windowKey === k ? "tab-active" : ""}`}
            >
              {WINDOW_LABEL[k]}
            </button>
          ))}
        </div>
      </header>

      <Status bot={bot} error={error} lastOkAt={lastOkAt} now={now} hasData={data != null} />

      <section className="card grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-4 lg:grid-cols-7" aria-label="Window totals">
        <Stat label="Entered" value={totals?.entered} color={RADAR_COLOR.ingest} />
        <Stat label="Scored" value={totals?.scored} color={RADAR_COLOR.score} />
        <Stat label="Stopped" value={totals?.stopped} color={RADAR_COLOR.reject} />
        <Stat label="Traded" value={totals?.traded} color={RADAR_COLOR.pass} />
        <Stat label="Open now" value={totals?.open} color={RADAR_COLOR.pass} />
        <Stat label="Won / lost" text={totals ? `${totals.won} / ${totals.lost}` : "—"} color={RADAR_COLOR.profit} />
        <Stat
          label="Realised"
          text={totals ? signedSol(totals.realizedPnlSol, 3) : "—"}
          tone={toneClass(toneOf(totals?.realizedPnlSol))}
          color={RADAR_COLOR.profit}
        />
      </section>

      <section className="card overflow-hidden">
        <RadarFlow
          counts={data?.counts ?? []}
          samples={data?.samples ?? []}
          focusId={focusId}
          onHover={(id) => setHovered(id)}
          onPick={(id) => {
            setPinned((p) => (p === id ? null : id));
            setCoin(null);
          }}
          resetKey={windowKey}
          emptyMessage={
            data == null
              ? "Loading the last few minutes…"
              : bot?.workerAlive === false
                ? "The worker is not running, so nothing is being ingested. Start it with pnpm worker."
                : "No coin reached any stage in this window."
          }
        />
        <Legend />
      </section>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <RejectionTable
          data={data}
          nowMs={now}
          onPickStage={(id) => {
            setPinned(id);
            setCoin(null);
          }}
          onPickCoin={(s) => setCoin(s)}
        />
        <StagePanel
          data={data}
          stageId={focusId}
          pinned={pinned != null}
          coin={coin}
          nowMs={now}
          onPickCoin={(s) => setCoin(s)}
          onUnpin={() => setPinned(null)}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  text,
  color,
  tone,
}: {
  label: string;
  value?: number;
  text?: string;
  color: string;
  tone?: string;
}) {
  return (
    <div className="bg-panel px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden="true" />
        <span className="text-[0.625rem] uppercase tracking-wider text-muted">{label}</span>
      </div>
      <div className={`font-mono text-base font-semibold tabular-nums ${tone ?? "text-fg"}`}>
        {text ?? (value != null ? value.toLocaleString("en-US") : "—")}
      </div>
    </div>
  );
}

function Status({
  bot,
  error,
  lastOkAt,
  now,
  hasData,
}: {
  bot: RadarSnapshot["bot"] | undefined;
  error: string | null;
  lastOkAt: number | null;
  now: number;
  hasData: boolean;
}) {
  const updated = lastOkAt ? `updated ${age(new Date(lastOkAt).toISOString(), now)} ago` : "";
  let text: string;
  let tone = "text-muted";
  let dot = "bg-muted";

  if (!hasData && !error) {
    text = "Connecting to the worker's data…";
  } else if (error) {
    text = `Can't reach the radar: ${error}${lastOkAt ? ` · showing the snapshot from ${age(new Date(lastOkAt).toISOString(), now)} ago` : ""}`;
    tone = "text-bad";
    dot = "bg-bad";
  } else if (bot && !bot.workerAlive) {
    text = `Worker offline — nothing is being ingested or scored · ${updated}`;
    tone = "text-warn";
    dot = "bg-warn";
  } else if (bot && !bot.running) {
    text = `Autotrade is off: coins are ingested and scored, but no gates, entries or exits run · ${updated}`;
    tone = "text-warn";
    dot = "bg-warn";
  } else {
    text = `Autotrade running${bot?.mode ? ` (${bot.mode})` : ""} · ${updated}`;
    tone = "text-ok";
    dot = "bg-ok";
  }

  return (
    <p className={`flex flex-wrap items-center gap-2 text-xs ${tone}`} aria-live="polite">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      {text}
      {bot && !bot.running && bot.workerAlive && (
        <Link href="/trade" prefetch={false} className="underline hover:text-fg">
          Start it on Trade
        </Link>
      )}
    </p>
  );
}

function Legend() {
  const items: Array<[string, string]> = [
    ["Ingested", RADAR_COLOR.ingest],
    ["Scored", RADAR_COLOR.score],
    ["Passed / traded", RADAR_COLOR.pass],
    ["Rejected", RADAR_COLOR.reject],
    ["Skipped", RADAR_COLOR.skipped],
    ["Take profit", RADAR_COLOR.profit],
    ["Trailing stop", RADAR_COLOR.trailing],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[0.6875rem] text-muted">
      {items.map(([label, color]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden="true" />
          {label}
        </span>
      ))}
      <span className="ml-auto">Stream width = coins · dots = coins arriving now</span>
    </div>
  );
}
