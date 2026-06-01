# Drizzle migrations — localhost safety

## Do not run drizzle-kit directly

The Drizzle meta journal (`meta/_journal.json`) ends at migration **0006**.

Migrations **0007 through 0016** were applied using the custom **`spr_migrations`** runner via:

```bash
pnpm db:migrate
```

**Never run:**

- `drizzle-kit push`
- `drizzle-kit diff`
- `drizzle-kit generate` (unless you know you are reconciling journal)

These commands compare against the stale journal and may propose **destructive** schema changes.

## Safe workflow

1. Add a new numbered SQL file under `drizzle/` (e.g. `0017_*.sql`).
2. Run `pnpm db:migrate` only.
3. Verify with `pnpm typecheck` and worker boot.

## paper_trades_compat VIEW

Migration 0015 created `paper_trades_compat` as a read bridge. Application reads now use an inline compat subquery over `paper_positions` via `lib/db/paper-read.ts`. The VIEW may be dropped manually once confirmed unused:

```sql
DROP VIEW IF EXISTS paper_trades_compat;
```

Do **not** drop the legacy `paper_trades` table — it may hold historical rows.

Migration **0017** drops `paper_trades_compat` via `pnpm db:migrate`.
