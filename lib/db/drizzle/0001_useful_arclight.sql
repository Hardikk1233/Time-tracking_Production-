CREATE TABLE "time_entry_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"time_entry_id" integer NOT NULL,
	"action" text NOT NULL,
	"actor_id" integer,
	"previous" jsonb,
	"next" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "time_entry_events_entry_idx" ON "time_entry_events" USING btree ("time_entry_id","created_at");--> statement-breakpoint
CREATE INDEX "time_entry_events_actor_idx" ON "time_entry_events" USING btree ("actor_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reporting_to_id_users_id_fk" FOREIGN KEY ("reporting_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_user_date_idx" ON "time_entries" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "time_entries_project_date_idx" ON "time_entries" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "time_entries_status_idx" ON "time_entries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "public_holidays_date_unique" ON "public_holidays" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "leaves_user_date_unique" ON "leaves" USING btree ("user_id","date");--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_hours_range" CHECK ("time_entries"."hours" > 0 AND "time_entries"."hours" <= 24);--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_billable_range" CHECK ("time_entries"."billable_hours" IS NULL OR ("time_entries"."billable_hours" >= 0 AND "time_entries"."billable_hours" <= "time_entries"."hours"));