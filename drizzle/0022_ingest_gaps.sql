-- T1.1 — WS Gap Recovery (v2 plan, Sprint 2).
--
-- Adds the watermark + gap-log tables, plus a blocked_reason column on
-- outcome_labels so the label-builder can mark labels blocked by gap rather
-- than silently computing them over incomplete event data.

-- Single-row HWM of the last consumed slot. CHECK enforces id=1.
CREATE TABLE IF NOT EXISTS "ingest_watermark" (
  "id"         SMALLINT PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "last_slot"  BIGINT      NOT NULL,
  "last_sig"   TEXT,
  "last_ts"    TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only log of WS coverage gaps + their recovery status.
CREATE TABLE IF NOT EXISTS "ingest_gaps" (
  "id"              BIGSERIAL PRIMARY KEY,
  "started_slot"    BIGINT      NOT NULL,
  "ended_slot"      BIGINT      NOT NULL,
  "started_ts"      TIMESTAMPTZ NOT NULL,
  "ended_ts"        TIMESTAMPTZ NOT NULL,
  "detected_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "recovered"       BOOLEAN     NOT NULL DEFAULT false,
  "recovered_count" INTEGER     NOT NULL DEFAULT 0,
  "scope"           VARCHAR(16) NOT NULL DEFAULT 'tracked',
  "note"            TEXT
);

-- Partial index for fast overlap lookup (only unrecovered gaps matter to
-- the label gate). Postgres can use this with started_ts/ended_ts predicates.
CREATE INDEX IF NOT EXISTS "ingest_gaps_open_window_idx"
  ON "ingest_gaps" ("started_ts", "ended_ts")
  WHERE NOT "recovered";

-- Let outcome_labels record why a label was NOT computed. Existing rows are
-- left NULL (= label computed normally / pending). The label-builder writes
-- 'gap' when an unrecovered ingest_gap overlaps the snapshot's horizon.
ALTER TABLE "outcome_labels"
  ADD COLUMN IF NOT EXISTS "blocked_reason" VARCHAR(32);
