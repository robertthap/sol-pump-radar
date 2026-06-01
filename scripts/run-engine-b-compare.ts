import { runEngineBCompare } from "../lib/continuation/engine-b-compare";

async function main() {
  const evalOnly = process.argv.includes("--eval-only");
  const report = await runEngineBCompare({ includeDexTop50: !evalOnly });

  console.log("\n=== Engine B Performance Report (A vs B) ===");
  console.log("cohort:", report.cohort, "mints:", report.mintCount);
  console.log("summary:", report.summary);

  const tableRows = (evalOnly ? report.rows.slice(0, 8) : report.rows.slice(0, 15)).map((r) => ({
    symbol: r.symbol,
    A: r.engineA.action,
    B: r.engineB.action,
    state: r.engineB.state,
    rank: r.engineB.rankPercentile.toFixed(2),
    missA: r.engineA.missType,
    missB: r.engineB.missType,
    deltaMs: r.firstDetectionDeltaMs,
    verdict: r.verdict,
  }));
  console.table(tableRows);

  console.log("\n--- 8-coin forensic (eval set) ---");
  for (const r of report.rows.filter((_, i) => i < 8)) {
    console.log(`\n${r.symbol} (${r.mint.slice(0, 8)}…)`);
    console.log("  Engine A:", r.engineA.action, "|", r.engineA.missType, "| first:", r.engineA.firstDetectionTs);
    console.log("  Engine B:", r.engineB.action, "|", r.engineB.missType, "| state:", r.engineB.state, "| rank:", r.engineB.rankPercentile.toFixed(2));
    console.log("  Timing B:", r.timing);
    console.log("  Detection delta (A−B ms):", r.firstDetectionDeltaMs, "(positive => A earlier)");
    console.log("  Miss delta:", r.missTypeDelta, "| verdict:", r.verdict);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
