-- Upgrade-plan Phase 0, issue #11: make OPEN-position ownership explicit.
--
-- Auto-session ownership of a paper position lives in entry_features->>'session_id'
-- (the global paper ledger has no per-auto-session column). Ownership queries
-- (capacity accounting, orphan detection in lib/auto/diagnostics.ts) filter on
-- that JSONB expression, so index it as a first-class, queryable concept. The
-- partial predicate keeps the index small — only OPEN rows are ever counted for
-- the concurrency cap.
CREATE INDEX IF NOT EXISTS paper_positions_session_owner_idx
  ON paper_positions ((entry_features->>'session_id'))
  WHERE state = 'OPEN';
