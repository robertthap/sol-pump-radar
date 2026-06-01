/**
 * Session profit autopsy (L0.1). Run: pnpm session:report
 *
 * Prints, for the last 7 days of auto-trader paper activity: closed-trade count,
 * win rate, expectancy, PnL by exit reason, strict-vs-relaxed tier performance,
 * top skip reasons, and recent learner tuning changes. This is the baseline you
 * measure before/after tuning — if closed=0 the problem is entries; if closed>0
 * and PnL≈0 the problem is exits/fees/filter quality.
 */
import { bootDb } from "../lib/db/client";
import {
  fetchAutoPaperOverall,
  fetchByExitReason,
  fetchByAction,
  fetchTierOverall,
  type OverallStats,
} from "../lib/db/repos/performance";
import { listRecentChanges } from "../lib/db/repos/tuner";
import { getActiveSession } from "../lib/db/repos/auto-sessions";

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}
function sol(n: number | null): string {
  return n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}

function printOverall(label: string, s: OverallStats) {
  console.log(
    `  ${label.padEnd(18)} trades=${String(s.trades).padStart(4)} ` +
      `win=${pct(s.winRate).padStart(6)} ` +
      `pnl=${sol(s.totalPnlSol).padStart(9)} ` +
      `exp=${sol(s.expectancySol).padStart(9)} ` +
      `avgHold=${s.avgHoldSeconds == null ? "—" : Math.round(s.avgHoldSeconds) + "s"}`,
  );
}

async function main() {
  process.env.SIGNAL_MODE ??= "hybrid";
  await bootDb();

  console.log("\n=== Session profit report (last 7 days, auto paper) ===\n");

  const hours = 24 * 7;
  const [overall, strict, relaxed, byReason, byAction, changes] = await Promise.all([
    fetchAutoPaperOverall(hours),
    fetchTierOverall("strict", hours),
    fetchTierOverall("relaxed", hours),
    fetchByExitReason(),
    fetchByAction(),
    listRecentChanges(10),
  ]);

  console.log("Overall");
  printOverall("auto (7d)", overall);
  if (overall.trades === 0) {
    console.log("\n  ⚠ No closed auto trades in the window — the bottleneck is ENTRIES.");
    console.log("    Check: worker running? SIGNAL_MODE=hybrid? fresh launches in decision_log?\n");
  }

  console.log("\nBy entry tier (strict vs relaxed)");
  printOverall("strict", strict);
  printOverall("relaxed", relaxed);
  if (strict.trades >= 10 && relaxed.trades >= 10) {
    const verdict =
      (strict.expectancySol ?? 0) > (relaxed.expectancySol ?? 0)
        ? "strict outperforms relaxed → consider disabling demo relax"
        : "relaxed holding up";
    console.log(`  → ${verdict}`);
  }

  console.log("\nBy exit reason");
  for (const r of byReason.slice(0, 8)) {
    console.log(
      `  ${r.reason.padEnd(14)} n=${String(r.count).padStart(4)} ` +
        `pnl=${sol(r.totalPnlSol).padStart(9)} avg=${sol(r.avgPnlSol).padStart(9)} ` +
        `share=${pct(r.share)}`,
    );
  }

  console.log("\nBy action");
  for (const a of byAction.slice(0, 6)) {
    console.log(
      `  ${a.action.padEnd(14)} n=${String(a.count).padStart(4)} ` +
        `win=${pct(a.winRate).padStart(6)} pnl=${sol(a.totalPnlSol).padStart(9)}`,
    );
  }

  const active = await getActiveSession();
  if (active) {
    const stats = active.stats;
    console.log(`\nActive session #${active.id} (${active.mode})`);
    console.log(
      `  opened=${stats.tradesOpened} closed=${stats.tradesClosed} ` +
        `wins=${stats.wins} losses=${stats.losses} pnl=${sol(stats.realizedPnlSol)}`,
    );
    const skips = stats.lastSkipReasons ?? [];
    if (skips.length) console.log(`  last skip reasons: ${skips.slice(0, 5).join(" · ")}`);
  } else {
    console.log("\nNo active session.");
  }

  console.log("\nRecent learner changes");
  if (changes.length === 0) {
    console.log("  (none — set AUTO_TUNE=on to let the learner apply tuning)");
  } else {
    for (const c of changes.slice(0, 8)) {
      console.log(`  [${c.status}] ${c.reason}`);
    }
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("session-report failed:", e);
  process.exit(1);
});
