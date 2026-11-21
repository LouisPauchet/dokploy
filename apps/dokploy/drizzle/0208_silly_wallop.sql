CREATE TYPE "public"."scheduleSource" AS ENUM('manual', 'label');--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "source" "scheduleSource" DEFAULT 'manual' NOT NULL;