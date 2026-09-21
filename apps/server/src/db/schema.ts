/**
 * Drizzle schema（#3 数据模型 V1）
 * 全局约定（Issue #42 §11）：UUIDv7 主键（应用层 uuidv7 包生成）；timestamptz；
 * 评分类 numeric(4,3)；project_id 贯穿业务表；枚举以 pg enum 实现。
 */
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** 项目命名空间（能力 2.5） */
export const projects = pgTable("projects", {
  id: id(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  meta: jsonb("meta"),
});
