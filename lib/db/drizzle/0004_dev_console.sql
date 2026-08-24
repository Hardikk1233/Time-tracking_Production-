CREATE TABLE "app_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"level" text DEFAULT 'error' NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"url" text,
	"method" text,
	"status_code" integer,
	"user_id" integer,
	"user_email" text,
	"user_agent" text,
	"request_id" text,
	"context" jsonb
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer,
	"user_email" text NOT NULL,
	"user_name" text NOT NULL,
	"user_role" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"message" text NOT NULL,
	"page_url" text,
	"user_agent" text,
	"status" text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_events_occurred_at_idx" ON "app_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "app_events_source_idx" ON "app_events" USING btree ("source");--> statement-breakpoint
CREATE INDEX "feedback_created_at_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "feedback" USING btree ("status");