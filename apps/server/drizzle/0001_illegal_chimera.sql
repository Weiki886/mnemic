CREATE TYPE "public"."provider_protocol" AS ENUM('openai-compatible', 'anthropic');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" "provider_protocol" NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"models" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_configs_name_unique" UNIQUE("name")
);
