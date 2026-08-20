ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entra_oid" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_entra_oid_unique" UNIQUE("entra_oid");