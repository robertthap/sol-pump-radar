import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type WalletClusterInfo = {
  clusterId: string;
  kind: string;
  confidence: number;
  memberCount: number;
};

/**
 * Look up cluster membership for a set of wallets in one query.
 * Returns a Map keyed by wallet address.
 */
export async function fetchClustersForWallets(
  wallets: string[],
): Promise<Map<string, WalletClusterInfo>> {
  if (wallets.length === 0) return new Map();
  const r = await getDb().execute(sql`
    SELECT cm.wallet, cm.cluster_id, c.kind, c.confidence::float8 AS confidence, c.member_count::int AS member_count
    FROM cluster_members cm
    JOIN clusters c ON c.id = cm.cluster_id
    WHERE cm.wallet = ANY(${sql.raw(`ARRAY[${wallets.map((w) => `'${w.replace(/'/g, "''")}'`).join(",")}]`)})
  `);
  type Raw = {
    wallet: string;
    cluster_id: string;
    kind: string;
    confidence: number;
    member_count: number;
  };
  const out = new Map<string, WalletClusterInfo>();
  for (const row of (r as unknown as { rows: Raw[] }).rows) {
    // Prefer bundle_ring > sniper_ring > co_buy when a wallet is in multiple
    const existing = out.get(row.wallet);
    const priority = (k: string) => (k === "bundle_ring" ? 3 : k === "sniper_ring" ? 2 : 1);
    if (!existing || priority(row.kind) > priority(existing.kind)) {
      out.set(row.wallet, {
        clusterId: row.cluster_id,
        kind: row.kind,
        confidence: row.confidence,
        memberCount: row.member_count,
      });
    }
  }
  return out;
}

export type MintRingExposure = {
  mint: string;
  bundleRingBuyers: number;
  sniperRingBuyers: number;
  totalRingBuyers: number;
};

/**
 * Count how many recent buyers of a given mint belong to known rings.
 * Used by the decision worker to veto a buy when a coin's recent demand
 * comes from a coordinated cluster.
 */
export async function fetchRingExposureForMint(mint: string, withinMinutes = 30): Promise<MintRingExposure> {
  const r = await getDb().execute(sql`
    WITH recent_buyers AS (
      SELECT DISTINCT wallet
      FROM events
      WHERE mint = ${mint}
        AND kind = 'buy'
        AND wallet IS NOT NULL
        AND ts > now() - ${sql.raw(`'${withinMinutes} minutes'::interval`)}
    )
    SELECT
      COUNT(*) FILTER (WHERE c.kind = 'bundle_ring')::int AS bundle_ring_buyers,
      COUNT(*) FILTER (WHERE c.kind = 'sniper_ring')::int AS sniper_ring_buyers,
      COUNT(*)::int AS total_ring_buyers
    FROM recent_buyers rb
    JOIN cluster_members cm ON cm.wallet = rb.wallet
    JOIN clusters c ON c.id = cm.cluster_id
  `);
  type Raw = {
    bundle_ring_buyers: number;
    sniper_ring_buyers: number;
    total_ring_buyers: number;
  };
  const row = (r as unknown as { rows: Raw[] }).rows[0];
  return {
    mint,
    bundleRingBuyers: row?.bundle_ring_buyers ?? 0,
    sniperRingBuyers: row?.sniper_ring_buyers ?? 0,
    totalRingBuyers: row?.total_ring_buyers ?? 0,
  };
}

export async function fetchManyRingExposures(mints: string[], withinMinutes = 30): Promise<Map<string, MintRingExposure>> {
  if (mints.length === 0) return new Map();
  const r = await getDb().execute(sql`
    WITH recent_buyers AS (
      SELECT DISTINCT mint, wallet
      FROM events
      WHERE mint = ANY(${sql.raw(`ARRAY[${mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")}]`)})
        AND kind = 'buy'
        AND wallet IS NOT NULL
        AND ts > now() - ${sql.raw(`'${withinMinutes} minutes'::interval`)}
    )
    SELECT
      rb.mint,
      COUNT(*) FILTER (WHERE c.kind = 'bundle_ring')::int AS bundle_ring_buyers,
      COUNT(*) FILTER (WHERE c.kind = 'sniper_ring')::int AS sniper_ring_buyers,
      COUNT(*)::int AS total_ring_buyers
    FROM recent_buyers rb
    JOIN cluster_members cm ON cm.wallet = rb.wallet
    JOIN clusters c ON c.id = cm.cluster_id
    GROUP BY rb.mint
  `);
  type Raw = {
    mint: string;
    bundle_ring_buyers: number;
    sniper_ring_buyers: number;
    total_ring_buyers: number;
  };
  const out = new Map<string, MintRingExposure>();
  for (const row of (r as unknown as { rows: Raw[] }).rows) {
    out.set(row.mint, {
      mint: row.mint,
      bundleRingBuyers: row.bundle_ring_buyers,
      sniperRingBuyers: row.sniper_ring_buyers,
      totalRingBuyers: row.total_ring_buyers,
    });
  }
  return out;
}

export type ClusterListDto = {
  id: string;
  kind: string;
  memberCount: number;
  confidence: number;
  label: string | null;
  updatedAt: string;
  members: string[];
  meta: Record<string, unknown> | null;
};

export async function fetchClustersList(opts?: {
  limit?: number;
  kind?: string | null;
}): Promise<ClusterListDto[]> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
  const kindFilter = opts?.kind?.trim() || null;
  const r = await getDb().execute(sql`
    SELECT
      c.id,
      c.kind,
      c.member_count::int AS member_count,
      c.confidence::float8 AS confidence,
      c.label,
      c.updated_at,
      c.meta,
      (
        SELECT array_agg(wallet ORDER BY wallet)
        FROM cluster_members
        WHERE cluster_id = c.id
      ) AS members
    FROM clusters c
    ${kindFilter ? sql`WHERE c.kind = ${kindFilter}` : sql``}
    ORDER BY c.confidence DESC, c.member_count DESC
    LIMIT ${limit}
  `);
  type Raw = {
    id: string;
    kind: string;
    member_count: number;
    confidence: number;
    label: string | null;
    updated_at: Date | string;
    meta: Record<string, unknown> | null;
    members: string[] | null;
  };
  return (r as unknown as { rows: Raw[] }).rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    memberCount: c.member_count,
    confidence: c.confidence,
    label: c.label,
    updatedAt: c.updated_at instanceof Date ? c.updated_at.toISOString() : String(c.updated_at),
    members: c.members ?? [],
    meta: c.meta,
  }));
}
