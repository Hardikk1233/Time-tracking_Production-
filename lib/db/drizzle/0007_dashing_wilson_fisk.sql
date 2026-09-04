CREATE TABLE "project_task_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"assignee_user_id" integer NOT NULL,
	"assigned_by_id" integer NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_task_assignments" ADD CONSTRAINT "project_task_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_assignments" ADD CONSTRAINT "project_task_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_assignments" ADD CONSTRAINT "project_task_assignments_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_assignments" ADD CONSTRAINT "project_task_assignments_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_assignments" ADD CONSTRAINT "project_task_assignments_project_task_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."project_tasks"("project_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_task_assignments_unique_idx" ON "project_task_assignments" USING btree ("project_id","task_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "project_task_assignments_assignee_idx" ON "project_task_assignments" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "project_task_assignments_project_idx" ON "project_task_assignments" USING btree ("project_id");