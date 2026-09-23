CREATE TABLE IF NOT EXISTS "retrieval_traces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"query_text" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"abstained" boolean NOT NULL,
	"reinforce_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retrieval_traces" ADD CONSTRAINT "retrieval_traces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
