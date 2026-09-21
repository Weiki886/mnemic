-- ============================================================================
-- Mnemic 数据模型 V1（Issue #3，核心 8 表）
--
-- 落地时固定的两条设计决策（对应 Issue #3 设计备注）：
--   1. RETRACT 后 Belief 的 status 落点 = 'retracted'
--      （deleted = 硬删除语义、expired = 自然失效，均不符"用户撤回"）。
--   2. Observation.valid_time（证据声称的生效时点，单点）落为 BeliefVersion
--      区间：valid_from = valid_time，valid_to = NULL（开口）；被取代时由
--      Resolver 关闭 valid_to / recorded_to。两端命名差异由此注释统一语义。
--      边界：valid_time 可空而 valid_from 非空——此时 valid_from 兜底为
--      Observation.recorded_at（系统首次获知之时），由 #16/#17 转换实现遵守。
--
-- authority 映射（决策 4，创建即写入）：
--   USER_CORRECTION=70 > USER_EXPLICIT=60 > PROJECT_FILE=50
--   > TOOL_OBSERVATION=40 > DOCUMENT=30 > WEB_CONTENT=20 > AGENT_INFERENCE=10
--
-- memory_embeddings.embedding 维度 1024 = Qwen3-Embedding-0.6B 默认；
-- 换维度走 REEMBED 迁移（#1 §11），不原地 ALTER。
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."assertion_intent" AS ENUM('ASSERT', 'UPDATE', 'CORRECT', 'RETRACT');--> statement-breakpoint
CREATE TYPE "public"."belief_status" AS ENUM('active', 'superseded', 'expired', 'deleted', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."observation_type" AS ENUM('fact', 'preference', 'decision', 'progress');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('USER_CORRECTION', 'USER_EXPLICIT', 'PROJECT_FILE', 'TOOL_OBSERVATION', 'DOCUMENT', 'WEB_CONTENT', 'AGENT_INFERENCE');--> statement-breakpoint
CREATE TYPE "public"."speaker" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."time_precision" AS ENUM('DAY', 'WEEK', 'MONTH', 'FUZZY');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"decision" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "belief_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"belief_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone NOT NULL,
	"recorded_to" timestamp with time zone,
	"supersedes_version_id" uuid,
	"source_observation_id" uuid,
	"resolver_version" text,
	"confidence" numeric(4, 3)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "beliefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"attribute" text NOT NULL,
	"current_version_id" uuid,
	"evidence_count" integer DEFAULT 1 NOT NULL,
	"confidence" numeric(4, 3),
	"salience" numeric(4, 3),
	"importance" numeric(4, 3),
	"is_profile" boolean DEFAULT false NOT NULL,
	"profile_dirty" boolean DEFAULT false NOT NULL,
	"status" "belief_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"belief_version_id" uuid NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"speaker" "speaker" NOT NULL,
	"raw_text" text NOT NULL,
	"msg_time" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "observation_type" NOT NULL,
	"subject" text NOT NULL,
	"attribute" text NOT NULL,
	"value" jsonb NOT NULL,
	"assertion_intent" "assertion_intent" NOT NULL,
	"source_type" "source_type" NOT NULL,
	"authority" smallint NOT NULL,
	"reliability" numeric(4, 3),
	"valid_time" timestamp with time zone,
	"time_precision" time_precision DEFAULT 'DAY' NOT NULL,
	"time_confidence" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"importance" numeric(4, 3),
	"confidence" numeric(4, 3),
	"entities" jsonb,
	"is_profile" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "belief_versions" ADD CONSTRAINT "belief_versions_belief_id_beliefs_id_fk" FOREIGN KEY ("belief_id") REFERENCES "public"."beliefs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "belief_versions" ADD CONSTRAINT "belief_versions_supersedes_version_id_belief_versions_id_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."belief_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "belief_versions" ADD CONSTRAINT "belief_versions_source_observation_id_observations_id_fk" FOREIGN KEY ("source_observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "beliefs" ADD CONSTRAINT "beliefs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "beliefs" ADD CONSTRAINT "beliefs_current_version_id_belief_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."belief_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_belief_version_id_belief_versions_id_fk" FOREIGN KEY ("belief_version_id") REFERENCES "public"."belief_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observations" ADD CONSTRAINT "observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observations" ADD CONSTRAINT "observations_evidence_id_messages_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "beliefs_project_subject_attribute_key" ON "beliefs" USING btree ("project_id","subject","attribute");--> statement-breakpoint
-- HNSW 向量索引（能力 2.7；drizzle-kit 不管理，手工维护于本迁移）
CREATE INDEX IF NOT EXISTS "memory_embeddings_embedding_hnsw" ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);
