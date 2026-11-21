CREATE TYPE "public"."scheduleExecutionMode" AS ENUM('exec', 'run', 'start');--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "executionMode" "scheduleExecutionMode" DEFAULT 'exec' NOT NULL;