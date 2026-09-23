CREATE TABLE IF NOT EXISTS "resolution_traces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"belief_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"previous_version_id" uuid,
	"result_version_id" uuid,
	"relation" text,
	"confidence_before" numeric(4, 3),
	"confidence_after" numeric(4, 3),
	"policies" jsonb NOT NULL,
	"model_snapshot" jsonb,
	"resolver_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resolution_traces" ADD CONSTRAINT "resolution_traces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resolution_traces" ADD CONSTRAINT "resolution_traces_belief_id_beliefs_id_fk" FOREIGN KEY ("belief_id") REFERENCES "public"."beliefs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resolution_traces" ADD CONSTRAINT "resolution_traces_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resolution_traces" ADD CONSTRAINT "resolution_traces_previous_version_id_belief_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."belief_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resolution_traces" ADD CONSTRAINT "resolution_traces_result_version_id_belief_versions_id_fk" FOREIGN KEY ("result_version_id") REFERENCES "public"."belief_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
