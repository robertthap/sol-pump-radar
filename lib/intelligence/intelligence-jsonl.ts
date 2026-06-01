import "server-only";
import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import type { EngineIntelligenceOutput } from "@/lib/intelligence/types";
import type { FusionMeta } from "@/lib/intelligence/engine-fusion";

const JSONL_DIR = resolve("./data/intelligence-traces");

function pathForDay(d = new Date()): string {
  return join(JSONL_DIR, `${d.toISOString().slice(0, 10)}.jsonl`);
}

export async function appendIntelligenceTrace(row: {
  output: EngineIntelligenceOutput;
  fusion: FusionMeta;
  legacyAction: string | null;
  committed: boolean;
}): Promise<void> {
  await mkdir(JSONL_DIR, { recursive: true });
  const line =
    JSON.stringify({
      ts: Date.now(),
      mint: row.output.mint,
      committed: row.committed,
      legacyAction: row.legacyAction,
      output: row.output,
      fusionReason: row.fusion.fusionReason,
      winner: row.fusion.winner,
    }) + "\n";
  await appendFile(pathForDay(), line, "utf8");
}
