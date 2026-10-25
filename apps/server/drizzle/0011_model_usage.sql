CREATE TABLE IF NOT EXISTS "model_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"conversation_id" uuid,
	"provider_name" text NOT NULL,
	"model_id" text NOT NULL,
	"slot" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" bigint NOT NULL,
	"prompt_tokens" bigint,
	"completion_tokens" bigint,
	"total_tokens" bigint,
	"reasoning_tokens" bigint,
	"cached_input_tokens" bigint,
	CONSTRAINT "model_usage_scope_check" CHECK ("model_usage"."conversation_id" is null or "model_usage"."project_id" is not null),
	CONSTRAINT "model_usage_slot_check" CHECK ("model_usage"."slot" in ('chat','extraction','embedding')),
	CONSTRAINT "model_usage_status_check" CHECK ("model_usage"."status" in ('success','error','aborted')),
	CONSTRAINT "model_usage_counts_check" CHECK ("model_usage"."duration_ms" >= 0 and "model_usage"."prompt_tokens" >= 0 and "model_usage"."completion_tokens" >= 0 and "model_usage"."total_tokens" >= 0 and "model_usage"."reasoning_tokens" >= 0 and "model_usage"."cached_input_tokens" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_usage_project_time_idx" ON "model_usage" USING btree ("project_id","started_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_usage_conversation_time_idx" ON "model_usage" USING btree ("conversation_id","started_at","id");