CREATE TABLE IF NOT EXISTS "trend_candidates" (
	"mint" varchar(64) PRIMARY KEY NOT NULL,
	"v_sol" double precision,
	"prev_v_sol" double precision,
	"last_trade_at" timestamp with time zone,
	"source" varchar(32) NOT NULL DEFAULT 'pump',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trend_candidates_updated_at_idx" ON "trend_candidates" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trend_candidates_last_trade_at_idx" ON "trend_candidates" USING btree ("last_trade_at");
