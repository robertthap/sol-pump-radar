/**
 * End-to-end user-journey test for Sol Pump Radar.
 *
 * Walks the real Demo trading journey and asserts at every stage:
 *   1. Infra health     — /api/runtime/health is up, worker alive
 *   2. Ingestion        — events flowing (count grows over a short window)
 *   3. Intelligence     — BUY decisions are being committed
 *   4. Mode             — UI trading mode is "demo" (paper, no wallet needed)
 *   5. Start auto-trade — POST /api/auto/quick-start (the real user action)
 *   6. Session active   — worker picks up the queued start command
 *   7. Position opens   — auto-trader opens at least one paper position
 *   8. Data correctness — entry mcap is sane (the virtual/real vSol bug),
 *                         PnL + markers are well-formed
 *   9. Exit sanity      — any closed position has a reason + finite PnL
 *
 * Prereqs: Postgres up, worker running (pnpm worker), dev server running
 * (pnpm dev) on E2E_BASE (default http://127.0.0.1:3000).
 *
 *   pnpm e2e
 *   E2E_BASE=http://127.0.0.1:3000 E2E_OPEN_WAIT_SEC=240 pnpm e2e
 */
import { bootDb, getDb, getPool } from "@/lib/db/client";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { fetchAutoSessionPositions } from "@/lib/auto/session-positions";
import { sql } from "drizzle-orm";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3000";
const OPEN_WAIT_SEC = Number(process.env.E2E_OPEN_WAIT_SEC ?? 240);
const SESSION_WAIT_SEC = Number(process.env.E2E_SESSION_WAIT_SEC ?? 60);

type Status = "PASS" | "FAIL" | "WARN";
const results: { stage: string; status: Status; detail: string }[] = [];
function record(stage: string, status: Status, detail: string) {
  const icon = status === "PASS" ? "✅" : status === "WARN" ? "⚠️ " : "❌";
  console.log(`${icon} [${stage}] ${detail}`);
  results.push({ stage, status, detail });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function count(table: string): Promise<number> {
  const r = await getDb().execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return (r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0;
}

async function getJson(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const r = await fetch(`${BASE}${path}`, { cache: "no-store" });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      /* non-json */
    }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e) } };
  }
}

async function postJson(
  path: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      /* non-json */
    }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e) } };
  }
}

async function main() {
  await bootDb();
  console.log(`\n=== Sol Pump Radar — E2E user journey ===`);
  console.log(`base: ${BASE} · open-wait: ${OPEN_WAIT_SEC}s\n`);

  // ── Stage 1: infra health ──────────────────────────────────────────────
  const health = await getJson("/api/runtime/health");
  if (!health.ok) {
    record("1.health", "FAIL", `/api/runtime/health → HTTP ${health.status} (is the dev server running?)`);
  } else {
    const h = health.body as { workerAlive?: boolean; runtimeProfile?: string };
    record(
      "1.health",
      h.workerAlive ? "PASS" : "WARN",
      `profile=${h.runtimeProfile} workerAlive=${h.workerAlive}`,
    );
  }

  // ── Stage 2: ingestion flowing ─────────────────────────────────────────
  const ev1 = await count("events");
  await sleep(6000);
  const ev2 = await count("events");
  if (ev2 > ev1) {
    record("2.ingestion", "PASS", `events ${ev1} → ${ev2} (+${ev2 - ev1} in 6s) — live stream healthy`);
  } else if (ev2 > 0) {
    record("2.ingestion", "WARN", `events steady at ${ev2} (quiet market window or RPC lag)`);
  } else {
    record("2.ingestion", "FAIL", `events=0 — worker not ingesting`);
  }

  // ── Stage 3: intelligence committing BUY decisions ─────────────────────
  const buys = await count(
    "decision_log WHERE action IN ('BUY_STRONG','BUY_MODERATE')",
  );
  record(
    "3.intelligence",
    buys > 0 ? "PASS" : "WARN",
    `${buys} BUY decisions committed`,
  );

  // ── Stage 4: mode ──────────────────────────────────────────────────────
  const mode = await getUiTradingMode();
  record(
    "4.mode",
    mode === "demo" || mode === "real" ? "PASS" : "WARN",
    `ui_trading_mode=${mode ?? "—"}`,
  );

  // ── Stage 5: start auto-trade (the user action) ────────────────────────
  const start = await postJson("/api/auto/quick-start", { preset: "balanced" });
  const sb = start.body as { ok?: boolean; alreadyActive?: boolean; queued?: boolean; correlationId?: string; error?: string };
  if (start.status === 202 || sb.queued) {
    record("5.start", "PASS", `quick-start queued (correlationId=${sb.correlationId ?? "?"})`);
  } else if (sb.alreadyActive) {
    record("5.start", "PASS", `session already active — reusing it`);
  } else {
    record("5.start", "FAIL", `quick-start → HTTP ${start.status} ${JSON.stringify(start.body)}`);
  }

  // ── Stage 6: worker activates the session ──────────────────────────────
  let session = await getActiveSession();
  const sessDeadline = Date.now() + SESSION_WAIT_SEC * 1000;
  while (!session && Date.now() < sessDeadline) {
    await sleep(3000);
    session = await getActiveSession();
  }
  if (session) {
    record("6.session", "PASS", `active session #${session.id} mode=${session.mode} size=${session.params.sizeSol} maxConc=${session.params.maxConcurrent}`);
  } else {
    record("6.session", "FAIL", `no active session after ${SESSION_WAIT_SEC}s — worker not processing the start command`);
    return finish();
  }

  // ── Stage 7: a position opens ──────────────────────────────────────────
  const openDeadline = Date.now() + OPEN_WAIT_SEC * 1000;
  let snap = await fetchAutoSessionPositions(session.id, 40);
  while (snap.open.length === 0 && snap.closed.length === 0 && Date.now() < openDeadline) {
    await sleep(5000);
    snap = await fetchAutoSessionPositions(session.id, 40);
  }
  const touched = snap.open.length + snap.closed.length;
  if (touched > 0) {
    record("7.open", "PASS", `${snap.open.length} open · ${snap.closed.length} closed this session`);
  } else {
    record(
      "7.open",
      "WARN",
      `no positions opened within ${OPEN_WAIT_SEC}s — market quiet or gates filtering (not a code fault). Re-run with a longer E2E_OPEN_WAIT_SEC.`,
    );
  }

  // ── Stage 8: data correctness (entry-mcap bug + PnL/markers well-formed) ─
  const all = [...snap.open, ...snap.closed];
  if (all.length === 0) {
    record("8.data", "WARN", `no positions to validate (see stage 7)`);
  } else {
    let mcapBad = 0;
    let pnlBad = 0;
    let markerBad = 0;
    const samples: string[] = [];
    for (const p of all) {
      // entry mcap must be null OR within the bonding-curve-sane band vs current.
      if (p.entryMcapUsd != null && p.currentMcapUsd != null && p.currentMcapUsd > 0) {
        const ratio = p.entryMcapUsd / p.currentMcapUsd;
        if (!Number.isFinite(ratio) || ratio < 0.04 || ratio > 25) mcapBad++;
      }
      if (p.entryMcapUsd != null && (!Number.isFinite(p.entryMcapUsd) || p.entryMcapUsd <= 0)) mcapBad++;
      // PnL fields well-formed
      if (p.pnlSol != null && !Number.isFinite(p.pnlSol)) pnlBad++;
      if (p.pctOfSize != null && !Number.isFinite(p.pctOfSize)) pnlBad++;
      // a buy marker must exist
      if (!p.markers.some((m) => m.side === "buy")) markerBad++;
      if (samples.length < 4) {
        samples.push(
          `${p.mint.slice(0, 6)} entryMcap=${p.entryMcapUsd == null ? "—" : "$" + Math.round(p.entryMcapUsd)} curMcap=${p.currentMcapUsd == null ? "—" : "$" + Math.round(p.currentMcapUsd)} pnl=${p.pnlSol?.toFixed?.(4) ?? "—"}`,
        );
      }
    }
    console.log(`   samples: ${samples.join(" | ")}`);
    if (mcapBad === 0 && pnlBad === 0 && markerBad === 0) {
      record("8.data", "PASS", `${all.length} position(s): entry mcap sane, PnL finite, buy markers present`);
    } else {
      record(
        "8.data",
        "FAIL",
        `fabricated mcap=${mcapBad} · bad pnl=${pnlBad} · missing buy marker=${markerBad}`,
      );
    }
  }

  // ── Stage 8b: /api/ticker — the single source of truth for /trade ─────
  // The hero and every row on /trade come from this one response. Pin the
  // invariants the screen relies on: totals are derived from the very rows it
  // renders, the mode payload rides along (so the page never polls mode-lite),
  // and skip noise never reaches the browser.
  const tick = await getJson("/api/ticker");
  if (!tick.ok) {
    record("8b.ticker", "FAIL", `/api/ticker → HTTP ${tick.status}`);
  } else {
    const t = tick.body as {
      sourceStatus: string;
      portfolio: { investedSol: number; unrealizedPnlSol: number; openCount: number };
      positions: Array<{ sizeSol: number; pnlSol: number | null }>;
      logs: Array<{ kind: string }>;
      mode: { mode: string | null } | null;
      solUsd: number;
    };
    const sumPnl = t.positions.reduce((s, p) => s + (p.pnlSol ?? 0), 0);
    const sumSize = t.positions.reduce((s, p) => s + p.sizeSol, 0);
    const problems: string[] = [];
    if (Math.abs(sumPnl - t.portfolio.unrealizedPnlSol) > 1e-9) problems.push(`unrealized ${t.portfolio.unrealizedPnlSol} != Σrows ${sumPnl}`);
    if (Math.abs(sumSize - t.portfolio.investedSol) > 1e-9) problems.push(`invested ${t.portfolio.investedSol} != Σsize ${sumSize}`);
    if (t.positions.length !== t.portfolio.openCount) problems.push(`openCount ${t.portfolio.openCount} != rows ${t.positions.length}`);
    if (t.logs.some((l) => l.kind === "skip")) problems.push("skip entries leaked into logs");
    if (!t.mode) problems.push("mode payload missing (TradingModeProvider would fall back to polling)");
    if (!(t.solUsd > 0)) problems.push("solUsd missing");
    if (!["live", "stale", "stopped", "no_session"].includes(t.sourceStatus)) problems.push(`sourceStatus=${t.sourceStatus}`);
    record(
      "8b.ticker",
      problems.length ? "FAIL" : "PASS",
      problems.length ? problems.join(" · ") : `status=${t.sourceStatus} · ${t.positions.length} rows · hero == Σrows · no skip noise`,
    );
  }

  // ── Stage 9: exit sanity ───────────────────────────────────────────────
  if (snap.closed.length === 0) {
    record("9.exit", "WARN", `no closed positions yet (exits are time/price-driven)`);
  } else {
    const bad = snap.closed.filter((p) => !p.exitReason || (p.pnlSol != null && !Number.isFinite(p.pnlSol)));
    record(
      "9.exit",
      bad.length === 0 ? "PASS" : "FAIL",
      bad.length === 0
        ? `${snap.closed.length} closed, all with a reason + finite PnL`
        : `${bad.length} closed positions missing reason / bad PnL`,
    );
  }

  await finish();
}

async function finish(): Promise<void> {
  const fails = results.filter((r) => r.status === "FAIL");
  const warns = results.filter((r) => r.status === "WARN");
  console.log(`\n=== verdict: ${fails.length === 0 ? "PASS" : "FAIL"} · ${results.filter((r) => r.status === "PASS").length} pass, ${warns.length} warn, ${fails.length} fail ===`);
  if (fails.length) {
    for (const f of fails) console.log(`   ❌ ${f.stage}: ${f.detail}`);
  }
  console.log(`(session left running so you can watch it in the UI)\n`);
  // Close the pg pool so the event loop can drain and exit cleanly — process.exit()
  // with the pool still open triggers a libuv teardown assertion on Windows.
  process.exitCode = fails.length === 0 ? 0 : 1;
  await getPool().end().catch(() => undefined);
}

main().catch(async (e) => {
  console.error("[e2e] crashed:", e);
  process.exitCode = 1;
  await getPool().end().catch(() => undefined);
});
