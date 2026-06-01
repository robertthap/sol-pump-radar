import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { walletsLocal } from "@/lib/db/schema";

export type StoredWallet = {
  id: bigint;
  label: string;
  publicKey: string;
  source: "generated" | "imported";
  encryptedSecret: string;
  createdAt: Date;
  updatedAt: Date;
};

function mapRow(r: typeof walletsLocal.$inferSelect): StoredWallet {
  return {
    id: r.id,
    label: r.label,
    publicKey: r.publicKey,
    source: (r.source === "imported" ? "imported" : "generated") as "imported" | "generated",
    encryptedSecret: r.encryptedSecret,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function loadWallet(): Promise<StoredWallet | null> {
  const rows = await getDb()
    .select()
    .from(walletsLocal)
    .orderBy(desc(walletsLocal.createdAt))
    .limit(1);
  if (!rows.length) return null;
  return mapRow(rows[0]!);
}

export async function walletExists(): Promise<boolean> {
  const rows = await getDb()
    .select({ id: walletsLocal.id })
    .from(walletsLocal)
    .limit(1);
  return rows.length > 0;
}

export async function saveWallet(opts: {
  source: "generated" | "imported";
  publicKey: string;
  encryptedSecret: string;
  label?: string;
}): Promise<StoredWallet> {
  const [inserted] = await getDb()
    .insert(walletsLocal)
    .values({
      source: opts.source,
      publicKey: opts.publicKey,
      encryptedSecret: opts.encryptedSecret,
      label: opts.label ?? "main",
    })
    .returning();
  if (!inserted) throw new Error("failed to insert wallet");
  return mapRow(inserted);
}

export async function deleteWallet(): Promise<void> {
  await getDb().delete(walletsLocal);
}

export async function deleteWalletById(id: bigint): Promise<void> {
  await getDb().delete(walletsLocal).where(eq(walletsLocal.id, id));
}
