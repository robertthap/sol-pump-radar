import { runEngineBReplay } from "../lib/continuation/replay-runner";

async function main() {
  const mint = process.argv.find((a) => a.startsWith("--mint="))?.split("=")[1];
  const hours = Number(process.argv.find((a) => a.startsWith("--hours="))?.split("=")[1] ?? "24");
  const result = await runEngineBReplay({
    mints: mint ? [mint] : undefined,
    timeWindowHours: hours,
  });
  for (const m of result.mints) {
    console.log("\n", m.mint, m.source, "steps:", m.steps.length, "firstAlert:", m.firstAlertTs);
    if (m.steps.length) {
      console.table(m.steps.slice(-8).map((s) => ({
        ts: new Date(s.ts).toISOString(),
        state: s.state,
        rank: s.rankPercentile.toFixed(2),
        action: s.action,
      })));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
