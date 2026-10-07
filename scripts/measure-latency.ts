/**
 * M05 — measure the real event -> decision -> fill latency. READ-ONLY.
 *
 * Paper fills default to `80 + random() * 200` ms, which is a guess, not a
 * measurement, and it is the single number deciding how much of a move a paper
 * fill is allowed to capture. This samples the real path from recorded data and
 * prints the percentiles to put in .env.
 *
 *   pnpm measure:latency
 *   pnpm measure:latency -- --hours 24 --limit 5000
 *
 * It issues SELECTs only: no inserts, no updates, no migrations, and it never
 * touches the circuit breaker or any session.
 *
 * Stages, kept separate because the point is to find which one dominates:
 *   ingest   event seen -> decoded            (ingest_facts, where recorded)
 *   persist  decoded -> committed             (events.ts vs inserted_at)
 *   decide   committed -> trader evaluated it (decision rows vs event ts)
 *   submit   decision -> fill recorded        (paper_trade_fills.latency_ms)
 */
import { bootDb, getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { latencyProfile, type LatencyStage } from "@spr/trading";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

const HOURS = Math.max(1, Number(arg("hours", "24")));
const LIMIT = Math.max(100, Math.min(100_000, Number(arg("limit", "5000"))));

async function sample(label: string, query: ReturnType<typeof sql>): Promise<number[]> {
  try {
    const res = await getDb().execute(query);
    const rows = (res as unknown as { rows: Array<{ ms: number | null }> }).rows;
    const out = rows.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n >= 0);
    return out;
  } catch (e) {
    console.log(`  ${label}: unavailable (${String(e).split("\n")[0]})`);
    return [];
  }
}

function line(name: string, p: { p50: number; p90: number; p99: number; n: number } | undefined) {
  if (!p) { console.log(`  ${name.padEnd(9)} no samples`); return; }
  console.log(
    `  ${name.padEnd(9)} p50 ${String(Math.round(p.p50)).padStart(6)}ms` +
    `   p90 ${String(Math.round(p.p90)).padStart(6)}ms` +
    `   p99 ${String(Math.round(p.p99)).padStart(6)}ms   (n=${p.n})`,
  );
}

async function main() {
  console.log(`Measuring latency over the last ${HOURS}h (up to ${LIMIT} samples per stage).`);
  console.log("READ-ONLY: this script issues SELECTs only.\n");
  await bootDb();

  const since = sql.raw(`now() - interval '${HOURS} hours'`);

  // persist: how long between the event's own timestamp and its row landing.
  const persist = await sample("persist", sql`
    SELECT EXTRACT(EPOCH FROM (inserted_at - to_timestamp(ts))) * 1000 AS ms
    FROM events
    WHERE inserted_at >= ${since} AND ts IS NOT NULL
    ORDER BY inserted_at DESC LIMIT ${LIMIT}
  `);

  // submit: the executor already records the delay it applied to each fill.
  const submit = await sample("submit", sql`
    SELECT latency_ms AS ms
    FROM paper_trade_fills
    WHERE created_at >= ${since}
    ORDER BY id DESC LIMIT ${LIMIT}
  `);

  // decide: entry decision time vs the event that triggered it, where the
  // auto-trader recorded both.
  const decide = await sample("decide", sql`
    SELECT EXTRACT(EPOCH FROM (p.created_at - f.created_at)) * 1000 AS ms
    FROM paper_positions p
    JOIN paper_trade_fills f ON f.position_id = p.id AND f.fill_type = 'OPEN'
    WHERE p.created_at >= ${since}
    ORDER BY p.id DESC LIMIT ${LIMIT}
  `);

  const samples: Partial<Record<LatencyStage, number[]>> = { persist, submit, decide };
  const profile = latencyProfile(samples);

  console.log("Per stage:");
  for (const s of ["ingest", "persist", "decide", "submit"] as const) line(s, profile.stages[s]);

  console.log("\nEnd to end:");
  line("total", profile.total ?? undefined);

  if (!profile.complete) {
    console.log(
      "\nINCOMPLETE: at least one stage had no samples. The total below covers only\n" +
      "the stages that did, so it UNDERSTATES real latency. Run the worker for a\n" +
      "while with paper trading active, then measure again.",
    );
  }
  if (profile.bottleneck) {
    console.log(
      `\nBottleneck: ${profile.bottleneck.stage} at p50 ` +
      `${Math.round(profile.bottleneck.p50Ms)}ms` +
      (profile.total ? ` (${(profile.bottleneck.shareOfTotal * 100).toFixed(0)}% of total)` : ""),
    );
  }

  // Only emit settings from a measurement worth trusting. A partial or
  // degenerate sample would hand the operator a 0ms latency — the most
  // optimistic setting available, and precisely the failure this exists to
  // prevent. Refusing is the honest output.
  const MIN_PLAUSIBLE_P50_MS = 5;
  const trustworthy =
    profile.total != null && profile.complete && profile.total.p50 >= MIN_PLAUSIBLE_P50_MS;

  if (trustworthy && profile.total) {
    console.log("\nPut these in .env so paper fills stop using the 80-280ms guess:\n");
    console.log(`PAPER_LATENCY_P50_MS=${Math.round(profile.total.p50)}`);
    console.log(`PAPER_LATENCY_P90_MS=${Math.round(profile.total.p90)}`);
    console.log(`PAPER_LATENCY_P99_MS=${Math.round(profile.total.p99)}`);
    console.log(
      "\nUntil they are set, every paper trade records latencyMeasured=false, and\n" +
      "its fills are a guess rather than a measurement.",
    );
  } else if (profile.total && profile.total.p50 < MIN_PLAUSIBLE_P50_MS) {
    console.log(
      `\nREFUSING to emit settings: measured p50 is ${Math.round(profile.total.p50)}ms, below the\n` +
      `${MIN_PLAUSIBLE_P50_MS}ms plausibility floor. A near-zero latency is almost certainly an\n` +
      "artefact of too few samples or of fills recorded with latency disabled, and\n" +
      "setting it would make every paper result optimistic. Collect real samples first.",
    );
  } else if (!profile.complete) {
    console.log(
      "\nREFUSING to emit settings: the profile is incomplete, so its total understates\n" +
      "real latency. Setting an understated latency is worse than leaving the guess in\n" +
      "place, because it looks measured.",
    );
  } else {
    console.log("\nNo samples at all — nothing to report. Is the worker running?");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); });
