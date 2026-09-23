CREATE TYPE "public"."pending_status" AS ENUM('pending', 'confirmed', 'expired', 'rejected', 'promoted');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"candidate" jsonb NOT NULL,
	"gate_scores" jsonb NOT NULL,
	"status" "pending_status" DEFAULT 'pending' NOT NULL,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_candidates" ADD CONSTRAINT "pending_candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_candidates" ADD CONSTRAINT "pending_candidates_evidence_id_messages_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
