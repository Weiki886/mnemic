ALTER TABLE "resolution_traces" ADD COLUMN IF NOT EXISTS "flags_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "retrieval_traces" ADD COLUMN IF NOT EXISTS "flags_snapshot" jsonb;