import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "postgresql://sol:sol@127.0.0.1:5432/solpump";

export default {
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
