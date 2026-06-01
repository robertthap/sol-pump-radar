CREATE TABLE IF NOT EXISTS "auto_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"mode" varchar(8) DEFAULT 'paper' NOT NULL,
	"params" jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_reason" varchar(128)
);
--> statement-breakpoint
ALTER TABLE "live_trades" ADD COLUMN "session_id" varchar(32);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_sessions_status_idx" ON "auto_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_sessions_started_at_idx" ON "auto_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_trades_session_idx" ON "live_trades" USING btree ("session_id");