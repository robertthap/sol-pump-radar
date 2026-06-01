import { getPool, endPool } from "./connect";
import { runMigrations } from "./migrate";

async function main() {
  const pool = getPool();
  await runMigrations(pool);
  await endPool();
  console.log("[@spr/db] migrations complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
