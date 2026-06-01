CREATE TABLE IF NOT EXISTS "mint_bot_flags" (
	"mint" varchar(64) PRIMARY KEY NOT NULL,
	"creator" varchar(64),
	"launch_slot" bigint,
	"launch_ts" timestamp with time zone,
	"has_bundle" boolean DEFAULT false NOT NULL,
	"has_sniper" boolean DEFAULT false NOT NULL,
	"has_bump_bot" boolean DEFAULT false NOT NULL,
	"mechanical_uptrend" boolean DEFAULT false NOT NULL,
	"bundle_wallet_count" integer DEFAULT 0 NOT NULL,
	"sniper_wallet_count" integer DEFAULT 0 NOT NULL,
	"bump_wallet_count" integer DEFAULT 0 NOT NULL,
	"early_unique_buyers" integer DEFAULT 0 NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_profiles" (
	"wallet" varchar(64) PRIMARY KEY NOT NULL,
	"distinct_mints" integer DEFAULT 0 NOT NULL,
	"closed_mints" integer DEFAULT 0 NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"avg_return" double precision,
	"std_return" double precision,
	"t_stat" double precision,
	"last_return" double precision,
	"last5_return" double precision,
	"last10_return" double precision,
	"first_seen" timestamp with time zone,
	"last_seen" timestamp with time zone,
	"is_bump_bot" boolean DEFAULT false NOT NULL,
	"bump_score" double precision,
	"sniper_rate" double precision,
	"bundle_rate" double precision,
	"recent_returns" jsonb,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mint_bot_flags_detected_idx" ON "mint_bot_flags" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mint_bot_flags_bundle_idx" ON "mint_bot_flags" USING btree ("has_bundle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_profiles_tstat_idx" ON "wallet_profiles" USING btree ("t_stat");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_profiles_last_seen_idx" ON "wallet_profiles" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_profiles_bump_idx" ON "wallet_profiles" USING btree ("is_bump_bot");