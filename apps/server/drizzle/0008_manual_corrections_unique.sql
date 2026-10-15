-- #70：迁移器在事务内执行；排除旧写入方并发创建，先整理历史重复项再加部分唯一索引。
LOCK TABLE "conversations" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- 保留 started_at 最早（同时间按 UUID）的专用会话供后续复用。
-- 其余仅改标题：保留会话 ID、messages 外键、原始时间和 meta，不丢弃/搬动历史证据。
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "project_id" ORDER BY "started_at", "id"
  ) AS position
  FROM "conversations"
  WHERE "title" = 'manual-corrections'
)
UPDATE "conversations" AS c
SET "title" = 'manual-corrections:legacy:' || c."id"::text
FROM ranked AS r
WHERE c."id" = r."id" AND r.position > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_manual_corrections_project_key" ON "conversations" USING btree ("project_id") WHERE "conversations"."title" = 'manual-corrections';
