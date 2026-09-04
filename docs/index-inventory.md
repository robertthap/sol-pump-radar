# Index inventory — `events` / `token_features`

Status: **INVESTIGATION ONLY. No index has been dropped, created or rebuilt.**

Captured 2026-09-04 with the worker running and ingesting (~360 sig/s). Scan counts
are **cumulative since database creation** — `pg_stat_database.stats_reset` is NULL —
so a zero here means "never used in the life of this database", not "unused during a
short sample.

## The headline number

```
events:  4,906 rows · 5.6 MB heap · 3,409 MB indexes · 8,348 MB database total
```

**Index bloat, not index need.** `EVENT_RETENTION_DAYS=7` prunes rows with `DELETE`;
autovacuum reclaims tuples (`n_dead_tup` = 0) but **never shrinks a btree**. Every
index below is still physically sized for the ~2.9 M rows the table held before the
prune. A btree over 4,906 rows should be well under 1 MB, so these are ~99.9% empty
pages.

**The single highest-value action requires dropping nothing:** `REINDEX` reclaims
essentially all 3.4 GB. Dropping even every genuinely-unused index below recovers
~869 MB — a quarter as much, with real risk. Sequence the rebuild first, then
re-measure before considering any drop.

---

## Inventory

### `events_sig_ix_uq` — **KEEP**

| | |
|---|---|
| Definition | `UNIQUE (signature, instruction_index)` |
| Size / scans | 969 MB / **59,035** |
| Constraint | Unique **index**, not a table constraint (`pg_constraint.conindid` → none) |
| Query usage | Every ingest write. `insertEvents` / `insertSwapEvents` rely on `onConflictDoNothing` against this index |
| Superseded | No |
| Action | **Keep. Rebuild only.** |
| Confidence | **High** |

This index *is* the ingest dedup mechanism. Because it is an index rather than a
declared constraint it is technically droppable — which makes it worth stating
plainly that dropping it would silently break deduplication and admit duplicate
events. Its size is bloat: 969 MB for 4,906 rows.

### `events_mint_id_idx` — **KEEP**

| | |
|---|---|
| Definition | `(mint, id)` |
| Size / scans | 803 MB / **86,403** |
| Query usage | Chart/candle pagination and mint-scoped id-ordered reads |
| Superseded | No — `id` ordering is not served by the `ts` indexes |
| Action | **Keep. Rebuild only.** |
| Confidence | **High** |

> **Correction to the Phase 1 report.** I recorded this as "113 scans — very low use
> for its size". That reading was taken *before* the worker was started. Under live
> load it is one of the busiest indexes on the table. It is not a drop candidate.

### `events_mint_venue_ts_idx` — **KEEP**

| | |
|---|---|
| Definition | `(mint, venue, ts)` |
| Size / scans | 130 MB / **127,745** |
| Action | **Keep.** Busiest index on the table, and the smallest of the mint indexes |
| Confidence | **High** |

### `events_wallet_venue_ts_idx` — **KEEP**

| | |
|---|---|
| Definition | `(wallet, venue, ts)` |
| Size / scans | 198 MB / **62,174** |
| Action | **Keep** — it is what the planner actually chooses for wallet lookups |
| Confidence | **High** |

### `events_mint_ts_idx` — **KEEP (review later)**

| | |
|---|---|
| Definition | `(mint, ts)` |
| Size / scans | 410 MB / **14,967** |
| Superseded | **Partially.** `(mint, venue, ts)` cannot serve a `(mint, ts)` range without a venue predicate, so this is not strictly redundant |
| Action | Keep for now. Re-measure after `REINDEX`; if venue-aware queries fully displace it, revisit |
| Confidence | **Medium** |

### `events_wallet_ts_idx` — **DROP CANDIDATE (strongest)**

| | |
|---|---|
| Definition | `(wallet, ts)` |
| Size / scans | **623 MB / 0** |
| Query usage | Wallet-scoped reads exist (`lib/workers/bot-detector.ts:242` — `WHERE wallet IN (…) AND kind IN ('buy','sell')`, no venue predicate) |
| Superseded | **Yes.** `events_wallet_venue_ts_idx (wallet, venue, ts)` has `wallet` as its leading column, so it serves wallet-only predicates too — and at 198 MB it is 3× smaller. The planner has chosen it **62,174** times and this one **zero** times |
| Action | **Propose drop** — after the rebuild, in a separate reviewed migration |
| Confidence | **High** |

### `token_features_confluence_idx` — **DROP CANDIDATE**

| | |
|---|---|
| Definition | `token_features (confluence_score)` |
| Size / scans | **176 MB / 0** |
| Query usage | **None found on this table.** Every `confluence_score` filter/sort in the codebase targets `decision_log`, not `token_features` — `paper-trades.ts:305,354` (`ORDER BY … confluence_score DESC`), `opportunities-lite.ts:93,276` (`WHERE d.confluence_score >= …`) |
| Superseded | No — simply unaddressed by any query |
| Action | **Propose drop** — separate reviewed migration |
| Confidence | **High** |

### `events_slot_idx` — **DROP CANDIDATE (weakest evidence)**

| | |
|---|---|
| Definition | `(slot)` |
| Size / scans | **70 MB / 0** |
| Query usage | No repo query filters or orders `events.slot`. Slot handling lives on `ingest_watermark` (`ingest-gaps.ts:30,58`), and gap recovery scopes replay by mint + timestamp |
| Superseded | No |
| Action | **Hold.** Lowest size payoff, and the plausible consumer — WebSocket gap recovery — is a rare path that may not have run in this database's lifetime |
| Confidence | **Medium** — zero scans is suggestive, not conclusive, exactly the case the brief warns about |

---

## Recommended sequence

1. **`REINDEX` the `events` indexes** during a worker-stopped window. Reclaims ~3.4 GB,
   drops nothing, and is fully reversible by rebuilding. Do this **first** — it changes
   the size evidence that any drop decision should rest on.
2. **Re-measure** sizes and scan counts after a representative soak on the rebuilt indexes.
3. Only then propose a migration dropping `events_wallet_ts_idx` and
   `token_features_confluence_idx` (~799 MB combined, both zero-scan since database
   creation, one demonstrably superseded).
4. Leave `events_slot_idx` in place pending evidence that gap recovery does not need it.
5. Longer term, day-partitioning `events` makes retention a partition **DROP**, which
   removes the bloat mechanism entirely rather than periodically cleaning up after it.
   Explicitly out of scope here.

No schema change is proposed for immediate application.
