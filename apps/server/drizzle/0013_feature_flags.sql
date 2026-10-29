CREATE TABLE IF NOT EXISTS "feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'server' NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"flags" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_scope_check" CHECK ("feature_flags"."scope" = 'server'),
	CONSTRAINT "feature_flags_version_check" CHECK ("feature_flags"."schema_version" = 1),
	CONSTRAINT "feature_flags_revision_check" CHECK ("feature_flags"."revision" >= 0 and "feature_flags"."revision" <= 9007199254740991),
	CONSTRAINT "feature_flags_values_check" CHECK (jsonb_typeof("feature_flags"."flags") = 'object'
    and "feature_flags"."flags" ?& array['retrieval_vector','retrieval_keyword','retrieval_entity','retrieval_time','memory_gate','decay','reranker','authority_resolution','read_time_resolution','read_time_reinforcement']
    and ("feature_flags"."flags" - array['retrieval_vector','retrieval_keyword','retrieval_entity','retrieval_time','memory_gate','decay','reranker','authority_resolution','read_time_resolution','read_time_reinforcement']) = '{}'::jsonb
    and jsonb_typeof("feature_flags"."flags"->'retrieval_vector') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'retrieval_keyword') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'retrieval_entity') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'retrieval_time') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'memory_gate') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'decay') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'reranker') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'authority_resolution') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'read_time_resolution') = 'boolean'
    and jsonb_typeof("feature_flags"."flags"->'read_time_reinforcement') = 'boolean')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feature_flags_scope_key" ON "feature_flags" USING btree ("scope");
--> statement-breakpoint
-- Singleton UUIDv7 identifies infrastructure configuration, not a project or operator.
-- Defaults are locked against the shared v1 contract by integration tests; replay never resets changes.
INSERT INTO "feature_flags" ("id", "scope", "schema_version", "revision", "flags")
VALUES ('01a18076-f23c-7f63-8b88-e788f3cfef97', 'server', 1, 0,
 '{"retrieval_vector":true,"retrieval_keyword":true,"retrieval_entity":false,"retrieval_time":false,"memory_gate":true,"decay":false,"reranker":false,"authority_resolution":true,"read_time_resolution":false,"read_time_reinforcement":false}'::jsonb)
ON CONFLICT ("scope") DO NOTHING;
