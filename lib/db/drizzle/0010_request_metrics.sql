CREATE TABLE "replica_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replica" text NOT NULL,
	"event_loop_lag_ms" real NOT NULL,
	"event_loop_max_ms" real NOT NULL,
	"rss_mb" real NOT NULL,
	"heap_used_mb" real NOT NULL,
	"requests" integer NOT NULL,
	"in_flight" integer NOT NULL,
	"pool_total" integer NOT NULL,
	"pool_idle" integer NOT NULL,
	"pool_waiting" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"kind" text DEFAULT 'api' NOT NULL,
	"method" text,
	"route" text NOT NULL,
	"status_code" integer,
	"duration_ms" real NOT NULL,
	"user_id" integer,
	"user_email" text,
	"replica" text,
	"request_id" text,
	"page" text,
	"extra" jsonb
);
--> statement-breakpoint
ALTER TABLE "request_metrics" ADD CONSTRAINT "request_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replica_samples_sampled_at_idx" ON "replica_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE INDEX "request_metrics_occurred_at_idx" ON "request_metrics" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "request_metrics_user_id_idx" ON "request_metrics" USING btree ("user_id");