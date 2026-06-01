import { bootDb } from "../lib/db/client";
import { runEngineBEval, checkOpsHealthy } from "../lib/continuation/eval-report";

async function main() {
  await bootDb();
  const ops = await checkOpsHealthy();
  const report = await runEngineBEval(ops);
  console.log("\nEngine B Eval —", report.evalSetVersion);
  console.log("matched:", report.summary.matched, "missed:", report.summary.missed);
  console.table(
    report.rows.map((r) => ({
      symbol: r.symbol,
      state: r.state,
      rank: r.rankPercentile.toFixed(2),
      action: r.action,
      miss: r.missType ?? "—",
      divergence: r.divergence,
    })),
  );
  if (report.summary.missed > 6) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
