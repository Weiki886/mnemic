import { and, asc, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { conversations } from "../db/schema.js";
import { CORRECTIONS_CONVERSATION_TITLE } from "./conversation-titles.js";
import { loadConversationMessages, messageViews } from "./context.js";
import { enqueueConversationExtraction } from "../tasks/extraction-outbox.js";
import { scheduleConversationWriteback } from "./service.js";

export async function resumeConversation(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  projectId: string,
  sourceId: string,
  currentId: string | undefined,
  options: Parameters<typeof scheduleConversationWriteback>[4],
) {
  // PostgreSQL UUID equality is case-insensitive; canonicalize before JS Set/find comparisons as well.
  projectId = projectId.toLowerCase();
  sourceId = sourceId.toLowerCase();
  currentId = currentId?.toLowerCase();
  const result = await db.transaction(async (tx) => {
    const ids = [...new Set([sourceId, ...(currentId ? [currentId] : [])])];
    // Consistent row-lock order for simultaneous A→B / B→A switches.
    const rows = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), inArray(conversations.id, ids)))
      .orderBy(asc(conversations.id))
      .for("update");
    if (rows.length !== ids.length) return { kind: "not_found" } as const;
    if (rows.some((r) => r.title === CORRECTIONS_CONVERSATION_TITLE))
      return { kind: "reserved" } as const;
    const source = rows.find((r) => r.id === sourceId)!;
    const history = await loadConversationMessages(tx, source);
    const views = await messageViews(tx, projectId, history);
    // Switching away also archives/extracts the current conversation. Validate it before ANY mutation.
    for (const row of rows) if (row.id !== source.id) await loadConversationMessages(tx, row);
    if (options.durableExtraction)
      for (const row of rows) await enqueueConversationExtraction(tx, projectId, row.id);
    const archived = rows.filter((r) => !r.endedAt);
    if (archived.length)
      await tx
        .update(conversations)
        .set({ endedAt: new Date() })
        .where(
          and(
            eq(conversations.projectId, projectId),
            inArray(
              conversations.id,
              archived.map((r) => r.id),
            ),
          ),
        );
    const [fork] = await tx
      .insert(conversations)
      .values({
        id: uuidv7(),
        projectId,
        title: source.title,
        meta: { resume: { version: 1, from: sourceId, message_ids: history.map((m) => m.id) } },
      })
      .returning();
    return {
      kind: "resumed",
      archived,
      conversation: {
        id: fork!.id,
        project_id: projectId,
        title: fork!.title,
        started_at: fork!.startedAt,
        ended_at: fork!.endedAt,
        resumed_from: sourceId,
        messages: views,
      },
    } as const;
  });
  if (result.kind === "resumed" && !options.durableExtraction) {
    for (const row of result.archived)
      await scheduleConversationWriteback(db, masterKey, row.id, projectId, options);
  }
  return result;
}
