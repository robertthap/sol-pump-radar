CREATE TABLE IF NOT EXISTS "user_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learned_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"feature_key" varchar(64) NOT NULL,
	"operator" varchar(8) NOT NULL,
	"threshold" double precision NOT NULL,
	"sample_n" integer NOT NULL,
	"loss_rate" double precision NOT NULL,
	"status" varchar(16) DEFAULT 'proposed' NOT NULL,
	"reason" text NOT NULL,
	"metrics" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loss_postmortems" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(16) NOT NULL,
	"trade_id" bigserial NOT NULL,
	"mint" varchar(64) NOT NULL,
	"pnl_sol" double precision NOT NULL,
	"pnl_pct" double precision,
	"exit_reason" varchar(64),
	"entry_action" varchar(32),
	"features" jsonb NOT NULL,
	"modules_at_entry" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_settings_updated_idx" ON "user_settings" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learned_rules_status_idx" ON "learned_rules" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learned_rules_feature_idx" ON "learned_rules" USING btree ("feature_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loss_postmortems_trade_idx" ON "loss_postmortems" USING btree ("source","trade_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loss_postmortems_mint_idx" ON "loss_postmortems" USING btree ("mint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loss_postmortems_recorded_idx" ON "loss_postmortems" USING btree ("recorded_at");