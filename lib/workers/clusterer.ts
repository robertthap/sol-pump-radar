import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import { clusters, clusterMembers } from "@/lib/db/schema";
import { UnionFind } from "@/lib/intel/union-find";

const log = logger("clusterer");

/**
 * Co-buy clusterer. Inspired by the "shared funder" cluster heuristic the
 * paper uses to detect bundle/sniper rings, but adapted to the data we
 * actually ingest (events stream, no on-chain SOL transfer indexer).
 *
 * Algorithm:
 *   1. Find pairs (a, b) of wallets who bought the same mint within 2 seconds
 *      of each other, on ≥3 distinct mints inside the lookback window.
 *   2. Union each such pair using UnionFind.
 *   3. Persist groups of size ≥ 2 to `clusters` and `cluster_members`,
 *      stamping a confidence based on shared-mint volume.
 *
 * Runs every 10 minutes — clustering is expensive and slow-changing.
 */
const TICK_MS = 10 * 60_000;
const FIRST_DELAY_MS = 90_000;
const PAIR_TIME_WINDOW_SEC = 2;
const MIN_SHARED_MINTS = 3;
const LOOKBACK_HOURS = 24;
const MAX_PAIRS = 5000;

type EdgeRow = {
  a: string;
  b: string;
  shared_mints: number;
  bundle_mints: number;
  sniper_mints: number;
};

async function fetchCoBuyEdges(): Promise<EdgeRow[]> {
  const interval = `${LOOKBACK_HOURS} hours`;
  // For each mint, find ordered pairs of wallets that bought within 2s of each
  // other; group by pair to count how many distinct mints they share.
  const res = await getDb().execute(sql`
    WITH buys AS (
      SELECT mint, wallet, ts
      FROM events
      WHERE kind = 'buy'
        AND wallet IS NOT NULL
        AND ts > now() - ${sql.raw(`'${interval}'::interval`)}
    ),
    pairs AS (
      SELECT
        b1.mint AS mint,
        LEAST(b1.wallet, b2.wallet) AS a,
        GREATEST(b1.wallet, b2.wallet) AS b
      FROM buys b1
      JOIN buys b2
        ON b1.mint = b2.mint
       AND b1.wallet < b2.wallet
       AND ABS(EXTRACT(EPOCH FROM (b2.ts - b1.ts))) <= ${PAIR_TIME_WINDOW_SEC}
    ),
    pair_mints AS (
      SELECT a, b, mint, COUNT(*)::int AS n
      FROM pairs
      GROUP BY a, b, mint
    ),
    flag_join AS (
      SELECT pm.a, pm.b, pm.mint,
             COALESCE(mbf.has_bundle, false) AS has_bundle,
             COALESCE(mbf.has_sniper, false) AS has_sniper
      FROM pair_mints pm
      LEFT JOIN mint_bot_flags mbf ON mbf.mint = pm.mint
    )
    SELECT
      a, b,
      COUNT(DISTINCT mint)::int AS shared_mints,
      COUNT(DISTINCT mint) FILTER (WHERE has_bundle)::int AS bundle_mints,
      COUNT(DISTINCT mint) FILTER (WHERE has_sniper)::int AS sniper_mints
    FROM flag_join
    GROUP BY a, b
    HAVING COUNT(DISTINCT mint) >= ${MIN_SHARED_MINTS}
    ORDER BY shared_mints DESC
    LIMIT ${MAX_PAIRS}
  `);
  return (res as unknown as { rows: EdgeRow[] }).rows;
}

function fingerprint(members: string[]): string {
  // Stable id for a cluster, based on its sorted membership.
  // Lets us update an existing cluster row instead of churning IDs every tick.
  const sorted = [...members].sort();
  // Use a short hash-ish prefix from the joined string to keep the column
  // length within 64 chars.
  let h = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    for (let j = 0; j < s.length; j++) {
      h = (h * 31 + s.charCodeAt(j)) | 0;
    }
  }
  const tag = (h >>> 0).toString(36);
  return `cb-${sorted.length}-${tag}-${sorted[0]!.slice(0, 6)}`;
}

async function recomputeAndPersist() {
  const edges = await fetchCoBuyEdges();
  if (edges.length === 0) {
    log.debug("no co-buy edges in window");
    return { groups: 0, members: 0 };
  }
  const uf = new UnionFind();
  for (const e of edges) uf.union(e.a, e.b);

  // Index edges by sorted-pair to score group membership.
  const edgeByPair = new Map<string, EdgeRow>();
  for (const e of edges) edgeByPair.set(`${e.a}|${e.b}`, e);

  const groups = uf.groups();
  let written = 0;
  let memberWritten = 0;

  // Wipe stale clusters older than 1 hour to avoid stale-row pile-up. We
  // re-insert what we just discovered.
  await getDb().execute(sql`
    DELETE FROM cluster_members
    WHERE cluster_id IN (SELECT id FROM clusters WHERE updated_at < now() - interval '1 hour')
  `);
  await getDb().execute(sql`
    DELETE FROM clusters WHERE updated_at < now() - interval '1 hour'
  `);

  for (const [, members] of groups) {
    if (members.length < 2) continue;

    // Aggregate this group's evidence
    let bundleMints = 0;
    let sniperMints = 0;
    let sharedMintsTotal = 0;
    let edgeCount = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = `${members[i] < members[j]! ? members[i]! : members[j]!}|${members[i] < members[j]! ? members[j]! : members[i]!}`;
        const e = edgeByPair.get(key);
        if (!e) continue;
        edgeCount++;
        sharedMintsTotal += e.shared_mints;
        bundleMints += e.bundle_mints;
        sniperMints += e.sniper_mints;
      }
    }
    if (edgeCount === 0) continue;

    const id = fingerprint(members);
    let kind = "co_buy";
    if (bundleMints > 0) kind = "bundle_ring";
    else if (sniperMints > 0) kind = "sniper_ring";

    // Confidence = how dense the cluster is. A perfectly connected cluster of
    // n nodes has n*(n-1)/2 pairs.
    const maxEdges = (members.length * (members.length - 1)) / 2;
    const density = maxEdges > 0 ? edgeCount / maxEdges : 0;
    // Sharedness scales with mints; cap at ~12 → 1.0
    const mintIntensity = Math.min(1, sharedMintsTotal / 12);
    const confidence = Math.max(0, Math.min(1, 0.5 * density + 0.5 * mintIntensity));

    await getDb()
      .insert(clusters)
      .values({
        id,
        kind,
        memberCount: members.length,
        confidence,
        label:
          kind === "bundle_ring"
            ? `bundle ring (${bundleMints} mints)`
            : kind === "sniper_ring"
              ? `sniper ring (${sniperMints} mints)`
              : `co-buy ring (${sharedMintsTotal} shared mints)`,
        meta: {
          edgeCount,
          maxEdges,
          density,
          sharedMintsTotal,
          bundleMints,
          sniperMints,
          windowHours: LOOKBACK_HOURS,
        },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: clusters.id,
        set: {
          kind,
          memberCount: members.length,
          confidence,
          updatedAt: new Date(),
          meta: {
            edgeCount,
            maxEdges,
            density,
            sharedMintsTotal,
            bundleMints,
            sniperMints,
            windowHours: LOOKBACK_HOURS,
          },
        },
      });
    written++;

    // Replace member rows with the fresh set
    await getDb().execute(sql`DELETE FROM cluster_members WHERE cluster_id = ${id}`);
    if (members.length > 0) {
      const rows = members.map((wallet) => ({
        clusterId: id,
        wallet,
        confidence,
        joinedAt: new Date(),
        evidence: { sharedMintsTotal, bundleMints, sniperMints },
      }));
      await getDb().insert(clusterMembers).values(rows);
      memberWritten += rows.length;
    }
  }

  return { groups: written, members: memberWritten };
}

export async function startClusterer() {
  log.info("clusterer starting", { tickMs: TICK_MS });
  async function tick() {
    try {
      const r = await recomputeAndPersist();
      if (r.groups > 0) log.info("clusters refreshed", r);
    } catch (e) {
      log.warn("clusterer tick failed", { err: String(e) });
    }
  }
  setTimeout(() => tick().catch(() => undefined), FIRST_DELAY_MS);
  const interval = setInterval(() => {
    tick().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(interval);
}
