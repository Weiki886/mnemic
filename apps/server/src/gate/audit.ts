import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { auditLog } from "../db/schema.js";

/**
 * 平台审计写入（audit_log 表由 #3 建立，#15 起复用）。
 * meta 按写入方定 schema——脱敏事件只记 { pattern }，绝不记密钥本体。
 */
export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  decision?: string;
  meta?: Record<string, unknown>;
}

export async function writeAuditLog(db: PostgresJsDatabase, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: uuidv7(),
    actor: entry.actor,
    action: entry.action,
    ...(entry.target !== undefined ? { target: entry.target } : {}),
    ...(entry.decision !== undefined ? { decision: entry.decision } : {}),
    ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  });
}
