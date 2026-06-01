import "server-only";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { normalizeDexSnapshot } from "@/lib/dex/normalizer";
import { engineB } from "@/lib/continuation/engine-b";
import { ENGINE_B_EVAL_SET } from "@/lib/continuation/eval-set";
import type { EngineBAction, EngineBTrace, MomentumState } from "@/lib/continuation/types";
import { computeCrossMintRanks } from "@/lib/continuation/cross-mint-rank";
import { rankInputFromResult } from "@/lib/continuation/cross-mint-rank";

const JSONL_DIR = resolve("./data/engine-b-traces");

export type ReplayStep = {
  ts: number;
  state: MomentumState;
  rankPercentile: number;
  rankVelocity: number;
  action: EngineBAction;
  score: number;
  reason: string;
};

export type ReplayMintResult = {
  mint: string;
  steps: ReplayStep[];
  firstAlertTs: number | null;
  source: "jsonl" | "db" | "simulated";
};

export type ReplayRunResult = {
  startedAt: number;
  timeWindowHours: number;
  mints: ReplayMintResult[];
};

async function loadJsonlTraces(mint: string, sinceMs: number): Promise<EngineBTrace[]> {
  if (!existsSync(JSONL_DIR)) return [];
  const files = await readdir(JSONL_DIR).catch(() => []);
  const traces: EngineBTrace[] = [];
  for (const f of files.filter((x) => x.endsWith(".jsonl"))) {
    const text = await readFile(join(JSONL_DIR, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as EngineBTrace;
        if (t.mint === mint && t.timestamp >= sinceMs) traces.push(t);
      } catch {
        /* skip */
      }
    }
  }
  return traces.sort((a, b) => a.timestamp - b.timestamp);
}

async function loadDbReplaySnapshots(mint: string, hours: number): Promise<ReplayStep[]> {
  await bootDb();
  try {
    const res = await getDb().execute(sql`
      SELECT ts, engine_b_json, continuation_score, alert_action
      FROM replay_snapshots
      WHERE mint = ${mint}
        AND ts > now() - (${sql.raw(String(hours))} || ' hours')::interval
      ORDER BY ts ASC
    `);
    const rows = (res as unknown as {
      rows: Array<{
        ts: string;
        engine_b_json: { state?: MomentumState; rankPercentile?: number; rankVelocity?: number; reason?: string; continuationScore?: number; action?: EngineBAction } | null;
        continuation_score: number;
        alert_action: string | null;
      }>;
    }).rows;
    return rows.map((r) => ({
      ts: new Date(r.ts).getTime(),
      state: r.engine_b_json?.state ?? "cold",
      rankPercentile: r.engine_b_json?.rankPercentile ?? 0,
      rankVelocity: r.engine_b_json?.rankVelocity ?? 0,
      action: (r.engine_b_json?.action as EngineBAction) ?? "NONE",
      score: r.continuation_score ?? r.engine_b_json?.continuationScore ?? 0,
      reason: r.engine_b_json?.reason ?? r.alert_action ?? "",
    }));
  } catch {
    return [];
  }
}

export async function runEngineBReplay(opts?: {
  mints?: string[];
  timeWindowHours?: number;
  stepMinutes?: number;
}): Promise<ReplayRunResult> {
  const mints = opts?.mints ?? ENGINE_B_EVAL_SET;
  const hours = opts?.timeWindowHours ?? 24;
  const stepMs = (opts?.stepMinutes ?? 5) * 60_000;
  const sinceMs = Date.now() - hours * 3600_000;
  const startedAt = Date.now();
  const results: ReplayMintResult[] = [];

  for (const mint of mints) {
    const jsonl = await loadJsonlTraces(mint, sinceMs);
    if (jsonl.length > 0) {
      const steps: ReplayStep[] = jsonl.map((t) => ({
        ts: t.timestamp,
        state: t.inputs.state,
        rankPercentile: t.inputs.rankPercentile,
        rankVelocity: t.inputs.rankVelocity,
        action: t.outputs.action,
        score: t.outputs.score,
        reason: t.finalReason,
      }));
      results.push({
        mint,
        steps,
        firstAlertTs: steps.find((s) => s.action === "ALERT" || s.action === "CONTINUATION_BUY")?.ts ?? null,
        source: "jsonl",
      });
      continue;
    }

    const dbSteps = await loadDbReplaySnapshots(mint, hours);
    if (dbSteps.length > 0) {
      results.push({
        mint,
        steps: dbSteps,
        firstAlertTs: dbSteps.find((s) => s.action === "ALERT" || s.action === "CONTINUATION_BUY")?.ts ?? null,
        source: "db",
      });
      continue;
    }

    const markets = await fetchDexMarketBatch([mint]);
    const raw = markets.get(mint);
    if (!raw) {
      results.push({ mint, steps: [], firstAlertTs: null, source: "simulated" });
      continue;
    }

    const normalized = normalizeDexSnapshot(raw);
    const steps: ReplayStep[] = [];
    const priorRanks = new Map<string, number>();
    const end = Date.now();
    for (let t = sinceMs; t <= end; t += stepMs) {
      const snap = { ...normalized, alignedTs: t };
      const { result } = engineB(mint, snap, {
        rankPercentile: 0.5,
        rankVelocity: 0,
        eventImpulse: 0,
        leadingScore: 0,
        universeSize: 1,
        persistTrace: false,
      });
      const ranks = computeCrossMintRanks(
        [rankInputFromResult(mint, snap, result)],
        priorRanks,
        stepMs / 60_000,
      );
      const r = ranks.get(mint)!;
      priorRanks.set(mint, r.rankPercentile);
      const { result: final } = engineB(mint, snap, {
        rankPercentile: r.rankPercentile,
        rankVelocity: r.rankVelocity,
        eventImpulse: 0,
        leadingScore: 0,
        universeSize: 1,
        persistTrace: false,
      });
      steps.push({
        ts: t,
        state: final.state,
        rankPercentile: final.rankPercentile,
        rankVelocity: final.rankVelocity,
        action: final.action,
        score: final.continuationScore,
        reason: final.reason,
      });
    }

    results.push({
      mint,
      steps,
      firstAlertTs: steps.find((s) => s.action === "ALERT" || s.action === "CONTINUATION_BUY")?.ts ?? null,
      source: "simulated",
    });
  }

  return { startedAt, timeWindowHours: hours, mints: results };
}
