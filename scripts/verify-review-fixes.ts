/** Post-review SQL smoke checks. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootDb, getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { env } from "@/lib/env";

function assertShadowLearnerRouting() {
  const src = readFileSync(
    resolve(process.cwd(), "lib/workers/shadow-learner.ts"),
    "utf8",
  );
  if (src.includes("@/lib/db/repos/paper-trades")) {
    throw new Error("P2.1b regression: shadow-learner imports paper-trades repo");
  }
  if (!src.includes("paperOpen") || !src.includes("loadOpenPositions")) {
    throw new Error("P2.1b regression: shadow-learner missing @spr/trading paths");
  }
  console.log("[verify] P2.1b shadow-learner routing: OK");
  console.log("[verify] P2.1a SHADOW_LEARNER:", env().SHADOW_LEARNER);
}

async function main() {
  assertShadowLearnerRouting();
  await bootDb();  const db = getDb();

  const hb = await db.execute(sql`
    SELECT name, last_beat
    FROM worker_heartbeat
    WHERE name IN ('auto-trader', 'intelligence-commit')
    ORDER BY name
  `);
  console.log("[verify] heartbeats:", (hb as { rows: unknown[] }).rows);

  const view = await db.execute(sql`
    SELECT to_regclass('public.paper_trades_compat') AS view_exists
  `);
  console.log("[verify] paper_trades_compat:", (view as { rows: unknown[] }).rows[0]);
  if ((view as { rows: Array<{ view_exists: string | null }> }).rows[0]?.view_exists != null) {
    throw new Error("P2.4: paper_trades_compat VIEW still exists — run pnpm db:migrate");
  }
  console.log("[verify] P2.4 VIEW dropped: OK");
  const modules = await db.execute(sql`
    SELECT mint, ts, action,
      (module_scores->>'M1_GRADUATION')::float8 AS m1,
      (module_scores->>'M3_RUG')::float8 AS m3
    FROM decision_log
    WHERE module_scores IS NOT NULL
      AND module_scores != '{}'::jsonb
    ORDER BY ts DESC
    LIMIT 5
  `);
  console.log("[verify] recent module_scores:", (modules as { rows: unknown[] }).rows);

  const skips = await db.execute(sql`
    SELECT COALESCE(executor_reason, 'unknown') AS reason, COUNT(*)::int AS n
    FROM decision_log
    WHERE executed = 'skipped'
      AND executor_reason LIKE 'auto:%'
      AND ts > now() - interval '1 hour'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 10
  `);
  console.log("[verify] auto skips (1h):", (skips as { rows: unknown[] }).rows);

  const pending = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM decision_log
    WHERE executed = 'pending'
      AND action IN ('BUY_STRONG', 'BUY_MODERATE')
      AND ts > now() - interval '90 seconds'
  `);
  console.log("[verify] pending buys (90s):", (pending as { rows: unknown[] }).rows[0]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
