CREATE TABLE "hour_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"hours" real NOT NULL,
	"purchased_on" date NOT NULL,
	"note" text,
	"created_by_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hour_blocks_hours_positive" CHECK ("hour_blocks"."hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"assignee_user_id" integer NOT NULL,
	"assigned_by_id" integer NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "engagement_type" text DEFAULT 'fte' NOT NULL;--> statement-breakpoint
ALTER TABLE "hour_blocks" ADD CONSTRAINT "hour_blocks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_blocks" ADD CONSTRAINT "hour_blocks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assignments" ADD CONSTRAINT "product_assignments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assignments" ADD CONSTRAINT "product_assignments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assignments" ADD CONSTRAINT "product_assignments_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assignments" ADD CONSTRAINT "product_assignments_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hour_blocks_client_idx" ON "hour_blocks" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_assignments_unique_idx" ON "product_assignments" USING btree ("product_id","client_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "product_assignments_assignee_idx" ON "product_assignments" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "product_assignments_client_idx" ON "product_assignments" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_name_unique_idx" ON "products" USING btree (lower("name"));