import { NextResponse } from "next/server";
import { z } from "zod";
import { loadStrategyReplayData } from "@/lib/db/repos/strategy-replay";
import { runReplay } from "@/lib/strategies/replay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const query = z.object({
  strategy: z.enum(["graduation", "curveLadder", "scaleIn"]),
  setting: z.enum(["OPTIMISTIC", "BASE", "CONSERVATIVE"]).default("BASE"),
  days: z.coerce.number().int().min(1).max(30).default(7),
  mints: z.coerce.number().int().min(1).max(200).default(100),
  targetWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
});
let running = false;

/** Computes an isolated replay; does not create sessions, orders, or ledger entries. */
export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid replay parameters", details: parsed.error.flatten() }, { status: 400 });
  if (running) return NextResponse.json({ error: "A recorded replay is already running. Try again when it finishes." }, { status: 429 });
  running = true;
  try {
    const { days, mints, ...options } = parsed.data;
    const data = await loadStrategyReplayData(days, mints);
    const result = runReplay(data.events, { ...options, seed: 1701, fromTs: data.fromTs ?? undefined });
    return NextResponse.json({ ...result, source: "recorded", data: {
      latestTs: data.latestTs, fromTs: data.fromTs, events: data.events.length, selectedMints: data.selectedMints,
      ageSeconds: data.latestTs == null ? null : Math.max(0, Date.now() / 1000 - data.latestTs),
      warnings: [
        `Bounded sample of the ${mints} most recently active mints. It is not the complete market universe.`,
        "Pool class is not stored in this feed. Curve class is inferred from reserve range; AMM class is unknown. Matched controls are exploratory until class provenance is available.",
        "Clock decisions assume 400ms per slot between observations. Unobserved feed outages cannot be distinguished from a quiet market.",
        "A curve position reaching graduation is censored when its exit cannot be filled before the venue changes.",
      ],
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("This sample exceeds") ? error.message :
      "Recorded replay could not load the local database. Check Postgres, then retry. The synthetic example works without it.";
    return NextResponse.json({ error: message }, { status: 503 });
  } finally { running = false; }
}
