CREATE TABLE IF NOT EXISTS "wallets_local" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"label" varchar(64) DEFAULT 'main' NOT NULL,
	"public_key" varchar(64) NOT NULL,
	"encrypted_secret" text NOT NULL,
	"source" varchar(16) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_trades" ALTER COLUMN "network" SET DEFAULT 'mainnet';--> statement-breakpoint
ALTER TABLE "live_trades" ADD COLUMN "tx_signature_open" varchar(96);--> statement-breakpoint
ALTER TABLE "live_trades" ADD COLUMN "tx_signature_close" varchar(96);--> statement-breakpoint
ALTER TABLE "live_trades" ADD COLUMN "dry_run" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "live_trades" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "live_trades" ADD COLUMN "route" varchar(16);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_local_pubkey_uq" ON "wallets_local" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallets_local_label_idx" ON "wallets_local" USING btree ("label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_trades_opened_at_idx" ON "live_trades" USING btree ("opened_at");