import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { conversations, messages, memoryTasks } from "../db/schema.js";
import { CORRECTIONS_CONVERSATION_TITLE } from "../chat/conversation-titles.js";
import { validateFileParents } from "../chat/attachments.js";
import { enqueueTask } from "./repository.js";

export async function enqueueExtraction(
  db: PostgresJsDatabase,
  projectId: string,
  evidenceId: string,
) {
  return enqueueTask(db, {
    projectId,
    type: "EXTRACT",
    payload: { evidence_id: evidenceId },
    idempotencyKey: `extract:${evidenceId}`,
  });
}
/** Called within the same transaction as archiving/forking. Never enqueue inherited references. */
export async function enqueueConversationExtraction(
  db: PostgresJsDatabase,
  projectId: string,
  conversationId: string,
) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId)))
    .limit(1);
  if (!conversation) throw Error("invalid extraction scope");
  if (conversation.title === CORRECTIONS_CONVERSATION_TITLE) return false;
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
  validateFileParents(rows);
  const pending = rows.filter((m) => !m.extractedAt && (m.speaker === "user" || m.attachment));
  for (const row of pending) await enqueueExtraction(db, projectId, row.id);
  return pending.length > 0;
}
/** Bounded compatibility recovery; existing dead/done tasks keep their original identity and policy. */
export async function recoverExtractionTasks(
  db: PostgresJsDatabase,
  options: { projectId?: string; signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const rows = await db
    .select({ id: messages.id, projectId: conversations.projectId })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        isNull(messages.extractedAt),
        sql`${conversations.title} is distinct from ${CORRECTIONS_CONVERSATION_TITLE}`,
        options.projectId ? eq(conversations.projectId, options.projectId) : undefined,
        sql`(${messages.speaker}='user' or (${messages.speaker}='tool' and ${messages.attachment} is not null))`,
        sql`not exists (select 1 from ${memoryTasks} where ${memoryTasks.projectId}=${conversations.projectId} and ${memoryTasks.type}='EXTRACT' and ${memoryTasks.idempotencyKey}='extract:' || ${messages.id}::text)`,
      ),
    )
    .orderBy(asc(messages.msgTime), asc(messages.id))
    .limit(100);
  for (const row of rows) {
    options.signal?.throwIfAborted();
    await enqueueExtraction(db, row.projectId, row.id);
  }
  return rows.length;
}
