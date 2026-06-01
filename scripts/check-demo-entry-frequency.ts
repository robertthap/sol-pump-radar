/**
 * P2.2 — demo/auto entry frequency check after Option A (qualifyEntry only).
 *
 * Run once:
 *   pnpm demo:freq-check
 *
 * Poll for 30 minutes (60s interval):
 *   pnpm demo:freq-check --watch
 *   pnpm demo:freq-check --watch --minutes 30 --interval 60
 */
import { bootDb } from "@/lib/db/client";
import { buildAutoDiagnostics, diagnosticsSummary } from "@/lib/auto/diagnostics";

function parseArgs() {
  const args = process.argv.slice(2);
  const watch = args.includes("--watch");
  const minutesIdx = args.indexOf("--minutes");
  const intervalIdx = args.indexOf("--interval");
  const minutes = minutesIdx >= 0 ? Number(args[minutesIdx + 1]) : 30;
  const intervalSec = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) : 60;
  return {
    watch,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
    intervalSec: Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60,
  };
}

type Verdict = "pass" | "warn_option_b" | "inconclusive";

function verdict(d: Awaited<ReturnType<typeof buildAutoDiagnostics>>): Verdict {
  if (!d.workersExpected || !d.workersRunning) return "inconclusive";
  if (d.autoPaperOpens30m > 0) return "pass";
  // Pending BUYs with zero opens while workers tick = filters doing their job (Option A).
  const filterBlocking =
    d.pendingBuy90s > 0 &&
    d.skippedLast1h.some((s) => s.reason.includes("auto:filter") || s.reason.includes("auto:strictness"));
  if (d.pendingBuy90s > 0 && !filterBlocking && !d.autoDemoRelax) {
    return "warn_option_b";
  }
  if (d.buyDecisions1h === 0 && d.pendingBuy90s === 0) return "inconclusive";
  return "pass";
}

function printSnapshot(d: Awaited<ReturnType<typeof buildAutoDiagnostics>>, label: string) {
  console.log(`\n[${label}] ${new Date().toISOString()}`);
  console.log("  summary:", diagnosticsSummary(d));
  console.log("  entryFilter:", d.entryFilter);
  console.log("  autoDemoRelax (bundle/mechanical bypass):", d.autoDemoRelax);
  console.log("  autoPaperOpens30m:", d.autoPaperOpens30m);
  console.log("  buyDecisions1h:", d.buyDecisions1h);
  console.log("  pendingBuy90s:", d.pendingBuy90s);
  console.log("  tradesOpened (session):", d.tradesOpened);
  if (d.skippedLast1h.length) {
    console.log("  top skips (1h):");
    for (const s of d.skippedLast1h.slice(0, 5)) {
      console.log(`    ${s.count}x ${s.reason}`);
    }
  }
  const v = verdict(d);
  if (v === "pass") {
    console.log(
      "  verdict: PASS — entries observed or pending BUYs blocked by qualifyEntry (Option A healthy)",
    );
  } else if (v === "warn_option_b") {
    console.log(
      "  verdict: WARN — BUY signals present but 0 auto opens/30m under Option A; consider AUTO_DEMO_RELAX=on",
    );
  } else {
    console.log("  verdict: INCONCLUSIVE — quiet market, workers off, or session not running");
  }
}

async function snapshotOnce() {
  await bootDb();
  return buildAutoDiagnostics();
}

async function main() {
  const { watch, minutes, intervalSec } = parseArgs();

  if (!watch) {
    const d = await snapshotOnce();
    printSnapshot(d, "once");
    if (verdict(d) === "warn_option_b") process.exit(2);
    return;
  }

  const ticks = Math.max(1, Math.ceil((minutes * 60) / intervalSec));
  console.log(
    `[demo:freq-check] watching ${minutes}m — ${ticks} samples every ${intervalSec}s`,
  );
  console.log("[demo:freq-check] start worker + demo auto session before this finishes");

  let lastWarn = false;
  for (let i = 0; i < ticks; i++) {
    const d = await snapshotOnce();
    printSnapshot(d, `${i + 1}/${ticks}`);
    lastWarn = verdict(d) === "warn_option_b";
    if (i + 1 < ticks) {
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }

  if (lastWarn) {
    console.log("\n[demo:freq-check] finished with WARN — Option B may be needed");
    process.exit(2);
  }
  console.log("\n[demo:freq-check] finished");
}

main().catch((e) => {
  console.error("[demo:freq-check] FAIL", e);
  process.exit(1);
});
