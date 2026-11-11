ALTER TABLE "provider_configs" ADD COLUMN IF NOT EXISTS "reranker_config" jsonb DEFAULT '{"revision":0,"config":null}'::jsonb NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_reranker_config_check" CHECK (
  case when jsonb_typeof("provider_configs"."reranker_config")='object' then coalesce(
    "provider_configs"."reranker_config" ?& array['revision','config']
    and ("provider_configs"."reranker_config" - array['revision','config'])='{}'::jsonb
    and case when jsonb_typeof("provider_configs"."reranker_config"->'revision')='number'
      and "provider_configs"."reranker_config"->>'revision' ~ '^(0|[1-9][0-9]{0,15})$'
      then ("provider_configs"."reranker_config"->>'revision')::numeric between 0 and 9007199254740991 else false end
    and case when "provider_configs"."reranker_config"->'config'='null'::jsonb then true
      when jsonb_typeof("provider_configs"."reranker_config"->'config')='object' then coalesce(
        ("provider_configs"."reranker_config"->'config') ?& array['endpoint_path','timeout_ms']
        and (("provider_configs"."reranker_config"->'config') - array['endpoint_path','timeout_ms'])='{}'::jsonb
        and jsonb_typeof("provider_configs"."reranker_config"->'config'->'endpoint_path')='string'
        and char_length("provider_configs"."reranker_config"->'config'->>'endpoint_path')<=512
        and "provider_configs"."reranker_config"->'config'->>'endpoint_path' ~ '^/([A-Za-z0-9_-]+/)*score$'
        and case when jsonb_typeof("provider_configs"."reranker_config"->'config'->'timeout_ms')='number'
          and "provider_configs"."reranker_config"->'config'->>'timeout_ms' ~ '^[0-9]{1,5}$'
          then ("provider_configs"."reranker_config"->'config'->>'timeout_ms')::numeric between 1 and 30000 else false end
      ,false) else false end
  ,false) else false end
);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
