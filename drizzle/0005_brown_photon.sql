CREATE TABLE IF NOT EXISTS "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" varchar(32) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" varchar(1000),
	"mint" varchar(64),
	"severity" varchar(16) DEFAULT 'info' NOT NULL,
	"extra" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_ts_idx" ON "notifications" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_kind_idx" ON "notifications" USING btree ("kind");