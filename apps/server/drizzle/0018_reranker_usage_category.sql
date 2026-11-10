-- Ledger category only; Provider configuration still has three model slots.
-- Replacement is one atomic statement, including when the SQL is replayed manually.
DO $$ BEGIN
  ALTER TABLE "model_usage" DROP CONSTRAINT IF EXISTS "model_usage_slot_check";
  ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_slot_check"
    CHECK ("model_usage"."slot" in ('chat','extraction','embedding','reranker'));
END $$;
