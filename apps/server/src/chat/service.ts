import { and, asc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { conversations, messages, projects } from "../db/schema.js";
import type { ResolveOptions } from "../providers/slots.js";
import { claimMessageForExtraction, runExtractionWriteback } from "./writeback.js";

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
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
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
  options: ResolveOptions & {
    onJob: (job: () => Promise<void>) => void;
    logger?: { error: (obj: object, msg: string) => void };
  },
): Promise<CommitResult> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return { kind: "not_found" };

  // 原子置 ended_at（并发 commit 只有一个成功；落选者即重复提交）
  const [updated] = await db
    .update(conversations)
    .set({ endedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.endedAt)))
    .returning();
  if (!updated) return { kind: "already_ended", conversation: toApi(row) };

  // 只提取"未被提取过的 user 消息"（决策 6：同一句话不重复计数佐证；
  // 助手回答不参与提取——模型自述不能成为事实来源）
  const pendingMsgs = await db
    .select({ id: messages.id, rawText: messages.rawText })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.speaker, "user"),
        isNull(messages.extractedAt),
      ),
    )
    .orderBy(asc(messages.msgTime));

  const extractionTriggered = pendingMsgs.length > 0;
  if (extractionTriggered) {
    const projectId = row.projectId;
    options.onJob(async () => {
      for (const msg of pendingMsgs) {
        // 先认领再提取：与并发单条路径互斥，认领失败者已被对方提取
        if (!(await claimMessageForExtraction(db, msg.id))) continue;
        try {
          // 每条消息单独提取，出处精确锚定消息自身
          await runExtractionWriteback(
            db,
            masterKey,
            { projectId, text: msg.rawText, evidenceId: msg.id },
            options,
          );
        } catch (err) {
          // 单条失败不阻塞其余消息（重试归 A1 #21 队列）
          options.logger?.error({ err, messageId: msg.id }, "commit writeback failed for message");
        }
      }
    });
  }
  return { kind: "committed", conversation: toApi(updated!), extractionTriggered };
}
