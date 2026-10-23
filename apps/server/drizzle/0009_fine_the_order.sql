DO $$ BEGIN
  CREATE TYPE "public"."message_generation_status" AS ENUM('complete', 'interrupted', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "generation_status" "message_generation_status";
