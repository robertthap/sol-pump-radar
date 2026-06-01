CREATE TABLE IF NOT EXISTS "rug_labels" (
	"mint" varchar(64) PRIMARY KEY NOT NULL,
	"label" varchar(16) NOT NULL,
	"labeled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone,
	"inactivity_seconds" integer NOT NULL,
	"peak_v_sol" double precision,
	"final_v_sol" double precision,
	"drawdown" double precision,
	"trades" integer,
	"unique_buyers" integer,
	"reason" varchar(200),
	"evidence" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rug_labels_label_idx" ON "rug_labels" USING btree ("label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rug_labels_labeled_at_idx" ON "rug_labels" USING btree ("labeled_at");