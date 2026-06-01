CREATE TABLE IF NOT EXISTS "tokens" (
	"mint" varchar(64) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_slot" bigint,
	"creator" varchar(64),
	"decimals" integer,
	"supply" text,
	"name" text,
	"symbol" text,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"graduated_at" timestamp with time zone,
	"last_safety_verdict" jsonb,
	"last_safety_at" timestamp with time zone,
	"blocked_for_trading" boolean DEFAULT false NOT NULL,
	"metadata_uri" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signature" varchar(96) NOT NULL,
	"instruction_index" integer DEFAULT 0 NOT NULL,
	"slot" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" varchar(24) NOT NULL,
	"mint" varchar(64),
	"wallet" varchar(64),
	"side" varchar(8),
	"sol_amount" double precision,
	"token_amount" double precision,
	"v_sol_after" double precision,
	"program" varchar(64),
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "parse_errors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signature" varchar(96) NOT NULL,
	"slot" bigint,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" varchar(128) NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creator_features" (
	"creator" varchar(64) PRIMARY KEY NOT NULL,
	"launches" integer DEFAULT 0 NOT NULL,
	"graduations" integer DEFAULT 0 NOT NULL,
	"rugs" integer DEFAULT 0 NOT NULL,
	"median_time_to_dump_sec" double precision,
	"spam_score" double precision,
	"creator_score" double precision,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_features" (
	"mint" varchar(64) NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"v_sol" double precision,
	"curve_progress" double precision,
	"curve_velocity_5m" double precision,
	"trades_per_sol" double precision,
	"buy_vol_5m" double precision,
	"sell_vol_5m" double precision,
	"buys_5m" integer,
	"sells_5m" integer,
	"ofi_1m" double precision,
	"ofi_5m" double precision,
	"ofi_15m" double precision,
	"holder_top1_pct" double precision,
	"holder_top10_pct" double precision,
	"unique_buyers_5m" integer,
	"holder_growth_5m" double precision,
	"bot_ratio" double precision,
	"insider_net_sol_5m" double precision,
	"successful_trader_count" integer,
	"momentum_score" double precision,
	"grad_score" double precision,
	"rug_score" double precision,
	"creator_score" double precision,
	"holder_health" double precision,
	"wash_score" double precision,
	"cluster_quality" double precision,
	"confluence_score" double precision,
	"meta_prob_good_trade" double precision,
	"calibrated_grad_prob" double precision,
	"extras" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_features" (
	"wallet" varchar(64) PRIMARY KEY NOT NULL,
	"first_seen" timestamp with time zone,
	"last_seen" timestamp with time zone,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"realized_pnl_sol" double precision DEFAULT 0 NOT NULL,
	"win_rate_30d" double precision,
	"avg_entry_slot_offset" double precision,
	"is_bot_score" double precision,
	"is_sniper_score" double precision,
	"insider_score" double precision,
	"cluster_id" varchar(64),
	"labels" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_edges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_wallet" varchar(64) NOT NULL,
	"to_wallet" varchar(64) NOT NULL,
	"lamports" bigint NOT NULL,
	"slot" bigint NOT NULL,
	"signature" varchar(96) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"edge_type" varchar(24) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cluster_members" (
	"cluster_id" varchar(64) NOT NULL,
	"wallet" varchar(64) NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clusters" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(24) NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"label" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mint" varchar(64) NOT NULL,
	"side" varchar(8) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"size_sol" double precision NOT NULL,
	"entry_price" double precision,
	"exit_price" double precision,
	"fees_sol" double precision DEFAULT 0 NOT NULL,
	"slippage_bps" double precision,
	"pnl_sol" double precision,
	"exit_reason" varchar(64),
	"entry_features" jsonb,
	"modules_at_entry" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"network" varchar(16) NOT NULL,
	"buy_signature" varchar(96),
	"sell_signature" varchar(96)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mint" varchar(64) NOT NULL,
	"side" varchar(8) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"size_sol" double precision NOT NULL,
	"entry_price" double precision,
	"exit_price" double precision,
	"fees_sol" double precision DEFAULT 0 NOT NULL,
	"slippage_bps" double precision,
	"pnl_sol" double precision,
	"exit_reason" varchar(64),
	"entry_features" jsonb,
	"modules_at_entry" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_outcomes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mint" varchar(64) NOT NULL,
	"decision_id" bigint,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"action_emitted" varchar(24) NOT NULL,
	"confluence_score" double precision,
	"price_t0" double precision,
	"price_t_1m" double precision,
	"price_t_5m" double precision,
	"price_t_30m" double precision,
	"price_t_1h" double precision,
	"graduated_within_24h" varchar(8),
	"extras" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_outcomes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" varchar(8) NOT NULL,
	"trade_id" bigint NOT NULL,
	"price_t0" double precision,
	"price_t_1m" double precision,
	"price_t_5m" double precision,
	"price_t_30m" double precision,
	"price_t_1h" double precision,
	"price_t_6h" double precision,
	"max_gain_pct" double precision,
	"max_drawdown_pct" double precision,
	"graduated_within_24h" varchar(8),
	"extras" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"mint" varchar(64) NOT NULL,
	"action" varchar(24) NOT NULL,
	"confluence_score" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"modules_fired" jsonb,
	"module_scores" jsonb,
	"vetoes" jsonb,
	"reason_human" varchar(512),
	"mode" varchar(8) NOT NULL,
	"executed" varchar(16) DEFAULT 'pending' NOT NULL,
	"executor_reason" varchar(128)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tuner_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" varchar(128) NOT NULL,
	"diff" jsonb NOT NULL,
	"metrics_before" jsonb,
	"metrics_after" jsonb,
	"reverted" varchar(8) DEFAULT 'no' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cb_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"state" varchar(16) NOT NULL,
	"severity" varchar(16) DEFAULT 'info' NOT NULL,
	"reason" varchar(128) NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dead_letters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"queue" varchar(64) NOT NULL,
	"job_name" varchar(64) NOT NULL,
	"attempts" integer NOT NULL,
	"error" varchar(512),
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rpc_health" (
	"endpoint" varchar(256) PRIMARY KEY NOT NULL,
	"kind" varchar(8) NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"p50_latency_ms" double precision,
	"p95_latency_ms" double precision,
	"error_rate_5m" double precision,
	"rate_limited_count" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"is_healthy" varchar(8) DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_creator_idx" ON "tokens" USING btree ("creator");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_status_idx" ON "tokens" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_created_at_idx" ON "tokens" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_sig_ix_uq" ON "events" USING btree ("signature","instruction_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_mint_ts_idx" ON "events" USING btree ("mint","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_wallet_ts_idx" ON "events" USING btree ("wallet","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_slot_idx" ON "events" USING btree ("slot");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_kind_idx" ON "events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creator_features_score_idx" ON "creator_features" USING btree ("creator_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_features_mint_ts_idx" ON "token_features" USING btree ("mint","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_features_confluence_idx" ON "token_features" USING btree ("confluence_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_features_insider_idx" ON "wallet_features" USING btree ("insider_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_features_cluster_idx" ON "wallet_features" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_edges_from_idx" ON "wallet_edges" USING btree ("from_wallet");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_edges_to_idx" ON "wallet_edges" USING btree ("to_wallet");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_edges_sig_idx" ON "wallet_edges" USING btree ("signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_members_cluster_idx" ON "cluster_members" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_members_wallet_idx" ON "cluster_members" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_trades_mint_idx" ON "live_trades" USING btree ("mint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_trades_closed_at_idx" ON "live_trades" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_trades_mint_idx" ON "paper_trades" USING btree ("mint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_trades_closed_at_idx" ON "paper_trades" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcomes_mint_idx" ON "signal_outcomes" USING btree ("mint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_outcomes_src_idx" ON "trade_outcomes" USING btree ("source","trade_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_log_mint_ts_idx" ON "decision_log" USING btree ("mint","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_log_action_idx" ON "decision_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cb_events_ts_idx" ON "cb_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cb_events_state_idx" ON "cb_events" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dead_letters_queue_ts_idx" ON "dead_letters" USING btree ("queue","ts");