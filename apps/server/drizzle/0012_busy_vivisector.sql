DO $$ BEGIN
 CREATE TYPE "public"."memory_task_status" AS ENUM('queued', 'running', 'done', 'failed', 'dead');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."memory_task_type" AS ENUM('EXTRACT', 'REEMBED', 'DECAY', 'COMPILE_PROFILE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "memory_task_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "memory_task_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"backoff_base_ms" integer DEFAULT 1000 NOT NULL,
	"backoff_cap_ms" integer DEFAULT 60000 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_tasks_attempts_check" CHECK ("memory_tasks"."max_attempts" between 1 and 100 and "memory_tasks"."attempts" between 0 and "memory_tasks"."max_attempts"),
	CONSTRAINT "memory_tasks_backoff_check" CHECK ("memory_tasks"."backoff_base_ms" between 1 and "memory_tasks"."backoff_cap_ms" and "memory_tasks"."backoff_cap_ms" <= 86400000),
	CONSTRAINT "memory_tasks_key_check" CHECK ("memory_tasks"."idempotency_key" ~ '^[A-Za-z0-9._:-]{1,200}$'),
	CONSTRAINT "memory_tasks_lease_check" CHECK ((
    "memory_tasks"."status" = 'running' and "memory_tasks"."lease_token" is not null and "memory_tasks"."lease_expires_at" is not null and "memory_tasks"."attempts" > 0
  ) or ("memory_tasks"."status" <> 'running' and "memory_tasks"."lease_token" is null and "memory_tasks"."lease_expires_at" is null)),
	CONSTRAINT "memory_tasks_terminal_check" CHECK (("memory_tasks"."status" in ('done','dead')) = ("memory_tasks"."finished_at" is not null)),
	CONSTRAINT "memory_tasks_error_check" CHECK ("memory_tasks"."last_error_code" is null or "memory_tasks"."last_error_code" in ('HANDLER_FAILED','TIMEOUT','LEASE_EXPIRED')),
	CONSTRAINT "memory_tasks_payload_check" CHECK (jsonb_typeof("memory_tasks"."payload") = 'object' and (
    ("memory_tasks"."type" in ('DECAY','COMPILE_PROFILE') and "memory_tasks"."payload" = '{}'::jsonb) or
    ("memory_tasks"."type" = 'EXTRACT' and "memory_tasks"."payload" ? 'evidence_id' and "memory_tasks"."payload" - 'evidence_id' = '{}'::jsonb and
      jsonb_typeof("memory_tasks"."payload"->'evidence_id') = 'string' and "memory_tasks"."payload"->>'evidence_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') or
    ("memory_tasks"."type" = 'REEMBED' and "memory_tasks"."payload" ? 'belief_version_id' and "memory_tasks"."payload" - 'belief_version_id' = '{}'::jsonb and
      jsonb_typeof("memory_tasks"."payload"->'belief_version_id') = 'string' and "memory_tasks"."payload"->>'belief_version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_tasks" ADD CONSTRAINT "memory_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_tasks_identity_key" ON "memory_tasks" USING btree ("project_id","type","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_tasks_due_idx" ON "memory_tasks" USING btree ("status","run_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_tasks_lease_idx" ON "memory_tasks" USING btree ("status","lease_expires_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_tasks_project_status_idx" ON "memory_tasks" USING btree ("project_id","status","created_at","id");