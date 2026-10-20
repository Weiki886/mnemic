import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { beliefVersions, beliefs, conversations, messages } from "../db/schema.js";

type Reader = Pick<PostgresJsDatabase, "select">;
type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
const UUID = z.string().uuid().toLowerCase();
const ResumeMeta = z.object({
  version: z.literal(1),
  from: UUID,
  message_ids: z.array(UUID),
});
export class ConversationContextError extends Error {}

/** Flattened Evidence references: no copied text and no recursive ancestry traversal. */
export function inheritedMessageIds(meta: unknown): string[] {
  if (!meta || typeof meta !== "object" || !("resume" in meta)) return [];
  const parsed = ResumeMeta.safeParse(meta.resume);
  if (!parsed.success) throw new ConversationContextError("会话历史引用无效");
  return [...new Set(parsed.data.message_ids)];
}

export async function loadConversationMessages(db: Reader, conv: Conversation): Promise<Message[]> {
  const ids = inheritedMessageIds(conv.meta);
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.projectId, conv.projectId),
        or(
          eq(messages.conversationId, conv.id),
          ids.length ? inArray(messages.id, ids) : undefined,
        ),
      ),
    )
    .orderBy(asc(messages.msgTime), asc(messages.id));
  const found = new Set(rows.map((r) => r.message.id));
  // JSON metadata is not a foreign key. Missing/foreign references must fail closed, not leak or silently truncate history.
  if (ids.some((id) => !found.has(id))) throw new ConversationContextError("会话历史引用不可用");
  return rows.map((r) => r.message);
}

export async function messageViews(
  db: Reader,
  projectId: string,
  msgs: Message[],
  activeOnly = false,
) {
  const refs = (m: Message): string[] =>
    Array.isArray(m.memories)
      ? m.memories.flatMap((id) => {
          const parsed = UUID.safeParse(id);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  const ids = [...new Set(msgs.flatMap(refs))];
  const cited = ids.length
    ? await db
        .select({
          belief_version_id: beliefVersions.id,
          belief_id: beliefs.id,
          subject: beliefs.subject,
          attribute: beliefs.attribute,
          value: beliefVersions.value,
        })
        .from(beliefVersions)
        .innerJoin(beliefs, eq(beliefVersions.beliefId, beliefs.id))
        .where(
          and(
            inArray(beliefVersions.id, ids),
            eq(beliefs.projectId, projectId),
            activeOnly ? eq(beliefs.status, "active") : undefined,
          ),
        )
    : [];
  const byId = new Map(cited.map((c) => [c.belief_version_id, c]));
  return msgs.map((m) => ({
    id: m.id,
    speaker: m.speaker,
    raw_text: m.rawText,
    msg_time: m.msgTime,
    memories: Array.isArray(m.memories)
      ? refs(m).flatMap((id) => {
          const c = byId.get(id);
          return c ? [c] : [];
        })
      : null,
  }));
}

/** Historical citations stay in assistant/tool context, never promoted to system instructions or current facts. */
export async function modelHistory(
  db: Reader,
  projectId: string,
  msgs: Message[],
): Promise<ModelMessage[]> {
  const views = await messageViews(db, projectId, msgs, true);
  return views.map((m) => ({
    role: m.speaker === "user" ? "user" : "assistant",
    content:
      (m.speaker === "tool" ? "【历史工具输出（仅文本）】\n" : "") +
      m.raw_text +
      (m.memories?.length
        ? "\n【当时引用的记忆，仅作历史上下文】\n" + JSON.stringify(m.memories)
        : ""),
  }));
}
