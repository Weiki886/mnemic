import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { conversations, messages, projects } from "../db/schema.js";
import type { ResolveOptions } from "../providers/slots.js";
import { runExtractionWriteback } from "./writeback.js";

/** 会话编排（#7）：创建/提交；消息应答在 respond.ts（Task B） */

export interface ConversationRow {
  id: string;
  project_id: string;
  title: string | null;
  started_at: Date;
  ended_at: Date | null;
}

function toApi(row: typeof conversations.$inferSelect): ConversationRow {
  return {
    id: row.id,
    project_id: row.projectId,
    title: row.title,
    started_at: row.startedAt,
    ended_at: row.endedAt,
  };
}

export async function createConversation(
  db: PostgresJsDatabase,
  input: { projectId: string; title?: string | undefined },
): Promise<ConversationRow | null> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) return null;
  const [row] = await db
    .insert(conversations)
    .values({ id: uuidv7(), projectId: input.projectId, title: input.title ?? null })
    .returning();
  return toApi(row!);
}

export type CommitResult =
  | { kind: "not_found" }
  | { kind: "already_ended"; conversation: ConversationRow }
  | { kind: "committed"; conversation: ConversationRow; extractionTriggered: boolean };

/**
 * 会话提交（session commit，能力 1.8 的 A0 触发点）：置 ended_at，
 * 有消息时触发批提取（全量转写 → 完整写入路径，候选锚定最后一条消息）。
 * 批提取为进程内异步：返回时 extractionTriggered 仅表示"已登记"，不代表已完成。
 */
export async function commitConversation(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  conversationId: string,
  options: ResolveOptions & { onJob: (job: () => Promise<void>) => void },
): Promise<CommitResult> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!row) return { kind: "not_found" };
  if (row.endedAt) return { kind: "already_ended", conversation: toApi(row) };

  const [updated] = await db
    .update(conversations)
    .set({ endedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning();

  const transcript = await db
    .select({ id: messages.id, speaker: messages.speaker, rawText: messages.rawText })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.msgTime));

  let extractionTriggered = false;
  if (transcript.length > 0) {
    extractionTriggered = true;
    const text = transcript.map((m) => `[${m.speaker}] ${m.rawText}`).join("\n");
    const lastMessageId = transcript.at(-1)!.id;
    const projectId = row.projectId;
    const job = (): Promise<void> =>
      runExtractionWriteback(db, masterKey, { projectId, text, evidenceId: lastMessageId }, options).then(() => undefined);
    options.onJob(job);
  }
  return { kind: "committed", conversation: toApi(updated!), extractionTriggered };
}
