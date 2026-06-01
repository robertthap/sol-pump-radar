/**
 * Cross-validation smoke test (run: pnpm validate)
 */
import { pickFusionWinner } from "../lib/intelligence/engine-fusion-core";
import { planMintsToEvaluateCore } from "../lib/intelligence/eval-scheduler-plan";
import { scoreLaunchHot } from "../lib/intelligence/launch-hot-gate";

const failures: string[] = [];
const passes: string[] = [];

function pass(msg: string) {
  passes.push(msg);
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string) {
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
}

async function main() {
  console.log("\n=== sol-pump-radar cross-validation ===\n");

  console.log("Environment (.env / defaults)");
  process.env.SIGNAL_MODE ??= "hybrid";
  process.env.WORKERS ??= "on";
  const { env, intelEnv } = await import("../lib/env");
  const e = env();
  pass(`SIGNAL_MODE=${e.SIGNAL_MODE} WORKERS=${e.WORKERS} RETENTION=${e.EVENT_RETENTION_DAYS}d`);
  const ic = intelEnv();
  pass(
    `intel tick=${ic.tickMs}ms universe=${ic.universeMax} skip=${ic.skipUnchangedMs}ms maxEval=${ic.maxEvaluatePerTick}`,
  );

  console.log("\nDatabase (Postgres boot)");
  const { bootDb, getDb } = await import("../lib/db/client");
  const { sql } = await import("drizzle-orm");
  await bootDb();
  pass("Postgres boot + migrations");

  const requiredTables = [
    "decision_log",
    "decision_trace",
    "continuation_candidates",
    "continuation_events",
    "engine_b_traces",
    "mint_registry",
    "events",
    "spr_migrations",
  ];
  for (const t of requiredTables) {
    const res = await getDb().execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${t}
      LIMIT 1
    `);
    const ok = (res as unknown as { rows: unknown[] }).rows.length > 0;
    if (ok) pass(`table ${t}`);
    else fail(`missing table ${t}`);
  }

  const mig = await getDb().execute(sql`SELECT COUNT(*)::int AS n FROM spr_migrations`);
  const migN = (mig as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0;
  if (migN >= 8) pass(`migrations applied (${migN})`);
  else fail(`migrations low count: ${migN}`);

  console.log("\nPure intelligence modules");
  const fusion = pickFusionWinner(
    {
      mint: "x",
      engine: "A",
      state: "early_breakout",
      signal: "BUY_STRONG",
      confidence: 0.8,
      rank_percentile: 0.85,
    },
    {
      mint: "x",
      engine: "B",
      state: "acceleration",
      signal: "CONTINUATION_BUY",
      confidence: 0.7,
      rank_percentile: 0.9,
    },
  );
  if (fusion.winner.signal === "BUY_STRONG") pass("fusion prefers BUY_STRONG over CONTINUATION_BUY when A leads");
  else fail(`unexpected fusion winner: ${fusion.winner.signal}`);

  const plan = planMintsToEvaluateCore(
    ["a", "b", "c"],
    new Set(["a", "b", "c"]),
    new Map([
      ["a", 0.95],
      ["b", 0.5],
      ["c", 0.1],
    ]),
    new Map(),
    {
      topRank: 1,
      skipUnchangedMs: 60_000,
      maxEvaluate: 2,
      maxLaunchHot: 1,
      launchHotMints: ["c"],
      continuationHotMints: ["b"],
      lastEvalAt: new Map(),
    },
    Date.now(),
  );
  if (plan.mints.includes("a") && plan.reasons.topRank >= 1) pass("eval plan prioritizes top rank");
  else fail("eval plan ordering broken");

  const launch = scoreLaunchHot(
    {
      mint: "m",
      creatorWallet: "creator",
      tradeCount: 4,
      uniqueWallets: 3,
      maxVSol: 5,
    },
    {
      minVSol: 2,
      minTrades: 1,
      minUniqueWallets: 2,
      minGates: 2,
      minHotScore: 0.45,
    },
  );
  if (launch.qualified) pass("launch hot gate accepts quality create");
  else fail("launch hot gate rejected valid create");

  console.log("\nAPI route files");
  const routes = [
    "app/api/health/route.ts",
    "app/api/intelligence/console/route.ts",
    "app/api/intelligence/token-bundle/route.ts",
    "app/api/intelligence/feed/route.ts",
    "app/api/signals/stream/route.ts",
    "app/mission/page.tsx",
  ];
  const fs = await import("fs/promises");
  for (const r of routes) {
    try {
      await fs.access(r);
      pass(`route ${r}`);
    } catch {
      fail(`missing ${r}`);
    }
  }

  console.log("\nSummary");
  console.log(`  Passed: ${passes.length}`);
  console.log(`  Failed: ${failures.length}`);
  if (failures.length) {
    console.error("\nFailures:\n", failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("\nAll cross-validation checks passed.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
