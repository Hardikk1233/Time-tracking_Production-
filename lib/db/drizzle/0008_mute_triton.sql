ALTER TABLE "leaves" ADD COLUMN "portion" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_portion_valid" CHECK ("leaves"."portion" IN (0.5, 1));