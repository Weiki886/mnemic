import { and, asc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { enqueueConversationExtraction } from "../tasks/extraction-outbox.js";
import { uuidv7 } from "uuidv7";
import { conversations, messages, projects } from "../db/schema.js";
import type { ResolveOptions } from "../providers/slots.js";
import { claimMessageForExtraction, runExtractionWriteback } from "./writeback.js";
import { fileMetadata, validateFileParents } from "./attachments.js";
import { ConversationContextError, loadConversationMessages } from "./context.js";

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
  | { kind: "context_invalid" }
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
    durableExtraction?: boolean;
    onJob: (job: () => Promise<void>) => void;
    logger?: { error: (obj: object, msg: string) => void };
  },
): Promise<CommitResult> {
  if (options.durableExtraction)
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for("update")
        .limit(1);
      if (!row) return { kind: "not_found" } as const;
      try {
        await loadConversationMessages(tx, row);
      } catch (error) {
        if (!(error instanceof ConversationContextError)) throw error;
        return { kind: "context_invalid" } as const;
      }
      if (row.endedAt) return { kind: "already_ended", conversation: toApi(row) } as const;
      const extractionTriggered = await enqueueConversationExtraction(tx, row.projectId, row.id);
      const [updated] = await tx
        .update(conversations)
        .set({ endedAt: new Date() })
        .where(eq(conversations.id, row.id))
        .returning();
      return { kind: "committed", conversation: toApi(updated!), extractionTriggered } as const;
    });
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return { kind: "not_found" };
  try {
    await loadConversationMessages(db, row);
  } catch (error) {
    if (!(error instanceof ConversationContextError)) throw error;
    return { kind: "context_invalid" };
  }

  // 原子置 ended_at（并发 commit 只有一个成功；落选者即重复提交）
  const [updated] = await db
    .update(conversations)
    .set({ endedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.endedAt)))
    .returning();
  if (!updated) return { kind: "already_ended", conversation: toApi(row) };

  const extractionTriggered = await scheduleConversationWriteback(
    db,
    masterKey,
    conversationId,
    row.projectId,
    options,
  );
  return { kind: "committed", conversation: toApi(updated!), extractionTriggered };
}

/** Schedule only physical user messages owned by this conversation, never inherited references. */
export async function scheduleConversationWriteback(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  conversationId: string,
  projectId: string,
  options: ResolveOptions & {
    durableExtraction?: boolean;
    onJob: (job: () => Promise<void>) => void;
    logger?: { error: (obj: object, msg: string) => void };
  },
): Promise<boolean> {
  if (options.durableExtraction)
    return enqueueConversationExtraction(db, projectId, conversationId);
  // Only physical user directives and validated file Evidence; never assistants or inherited rows.
  const pendingMsgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.msgTime));
  validateFileParents(pendingMsgs);
  const pendingEvidence = pendingMsgs.filter(
    (msg) => !msg.extractedAt && (msg.speaker === "user" || msg.attachment),
  );

  const extractionTriggered = pendingEvidence.length > 0;
  if (extractionTriggered) {
    options.onJob(async () => {
      for (const msg of pendingEvidence) {
        // 先认领再提取：与并发单条路径互斥，认领失败者已被对方提取
        if (!(await claimMessageForExtraction(db, msg.id))) continue;
        try {
          // 每条消息单独提取，出处精确锚定消息自身
          await runExtractionWriteback(
            db,
            masterKey,
            {
              projectId,
              text: msg.rawText,
              evidenceId: msg.id,
              ...(fileMetadata(msg) ? { channel: "project-file" as const } : {}),
            },
            options,
          );
        } catch (err) {
          // 单条失败不阻塞其余消息（重试归 A1 #21 队列）
          options.logger?.error({ err, messageId: msg.id }, "commit writeback failed for message");
        }
      }
    });
  }
  return extractionTriggered;
}
