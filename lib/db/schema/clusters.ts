import {
  pgTable,
  varchar,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const clusters = pgTable("clusters", {
  id: varchar("id", { length: 64 }).primaryKey(),
  kind: varchar("kind", { length: 24 }).notNull(),
  memberCount: integer("member_count").notNull().default(0),
  confidence: doublePrecision("confidence").notNull().default(0),
  label: varchar("label", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb("meta"),
});

export const clusterMembers = pgTable(
  "cluster_members",
  {
    clusterId: varchar("cluster_id", { length: 64 }).notNull(),
    wallet: varchar("wallet", { length: 64 }).notNull(),
    confidence: doublePrecision("confidence").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    evidence: jsonb("evidence"),
  },
  (t) => ({
    cluster: index("cluster_members_cluster_idx").on(t.clusterId),
    wallet: index("cluster_members_wallet_idx").on(t.wallet),
  }),
);
