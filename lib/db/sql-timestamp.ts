import { sql } from "drizzle-orm";

/** Timestamp literal helper (typed) for cases where parameterized Date binding is awkward. */
export function sqlTimestamptz(d: Date): ReturnType<typeof sql.raw> {
  const iso = d.toISOString().replace(/'/g, "''");
  return sql.raw(`'${iso}'::timestamptz`);
}
