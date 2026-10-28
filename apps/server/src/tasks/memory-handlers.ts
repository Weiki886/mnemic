import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import {
  beliefs,
  beliefVersions,
  conversations,
  messages,
  memoryEmbeddings,
} from "../db/schema.js";
import { CORRECTIONS_CONVERSATION_TITLE } from "../chat/conversation-titles.js";
import { fileMetadata, validateFileParents } from "../chat/attachments.js";
import { applyExtraction } from "../chat/writeback.js";
import { extractCandidates } from "../extraction/extractor.js";
import { resolveModel, type ResolveOptions } from "../providers/slots.js";
import { prepareBeliefEmbedding } from "../retrieval/embed.js";
import { emitDebugTrace, type DebugEvent } from "../debug/trace.js";
import { completeTaskWith, enqueueTask, type ClaimedTask } from "./repository.js";
import type { TaskHandler } from "./worker.js";

/** Same order for all durable memory commits. Provider calls must never run under this lock. */
async function projectLock(db: PostgresJsDatabase, projectId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext('mnemic.memory.tasks'), hashtext(${projectId}))`,
  );
}
async function source(db: PostgresJsDatabase, task: Readonly<ClaimedTask>) {
  const id = task.payload.evidence_id;
  if (task.type !== "EXTRACT" || !id) throw Error("invalid extraction task");
  const [row] = await db
    .select({ message: messages, projectId: conversations.projectId, title: conversations.title })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(messages.id, id), eq(conversations.projectId, task.projectId)))
    .limit(1);
  if (!row || row.title === CORRECTIONS_CONVERSATION_TITLE) throw Error("invalid extraction scope");
  const message = row.message;
  const meta = fileMetadata(message);
  if (message.speaker !== "user" && !meta) throw Error("invalid extraction evidence");
  if (meta) {
    const [parent] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, meta.parent_message_id))
      .limit(1);
    validateFileParents([message, ...(parent ? [parent] : [])]);
  }
  return { message, channel: meta ? ("project-file" as const) : undefined };
}
/** Real handlers own their atomic success receipt. Worker fallback acknowledgement then does nothing. */
export function createMemoryTaskHandlers(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  options: ResolveOptions = {},
): { EXTRACT: TaskHandler; REEMBED: TaskHandler } {
  const key = Buffer.from(masterKey),
    opts = { ...options };
  return {
    EXTRACT: async (task, context) => {
      let conversationId: string | undefined;
      let phase: "extraction" | "gate" | "ingest" = "extraction";
      try {
        context.checkpoint();
        const before = await source(db, task),
          message = before.message;
        conversationId = message.conversationId;
        const scoped: ResolveOptions = {
          ...opts,
          debugEvidenceId: message.id,
          usageContext: {
            projectId: task.projectId,
            conversationId: message.conversationId,
            purpose: "extraction",
          },
        };
        const extraction = message.extractedAt
          ? undefined
          : await (async () => {
              const { model } = await resolveModel(db, key, "extraction", scoped);
              return extractCandidates(model, message.rawText, { signal: context.signal });
            })();
        context.checkpoint();
        if (extraction?.degraded) throw Error("extraction degraded");
        phase = "ingest";
        const events: DebugEvent[] = [];
        await db.transaction(async (tx) => {
          await projectLock(tx, task.projectId);
          await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, message.conversationId),
                eq(conversations.projectId, task.projectId),
              ),
            )
            .for("update");
          await tx
            .select({ id: messages.id })
            .from(messages)
            .where(eq(messages.id, message.id))
            .for("update");
          await completeTaskWith(tx, task, async (owned) => {
            context.checkpoint();
            const current = await source(owned, task);
            if (current.message.extractedAt) return;
            if (
              !extraction ||
              current.message.rawText !== message.rawText ||
              current.message.speaker !== message.speaker ||
              JSON.stringify(current.message.attachment) !== JSON.stringify(message.attachment)
            )
              throw Error("extraction evidence changed");
            events.push({
              event: "memory.extraction.completed",
              target_id: message.id,
              detail: {
                project_id: task.projectId,
                conversation_id: message.conversationId,
                attempts: extraction.attempts,
                candidates_count: extraction.candidates.length,
                dropped_count: extraction.droppedCount,
                degraded: false,
              },
            });
            await applyExtraction(
              owned,
              {
                projectId: task.projectId,
                text: message.rawText,
                evidenceId: message.id,
                ...(current.channel ? { channel: current.channel } : {}),
              },
              message.conversationId,
              extraction,
              { ...scoped, debugTrace: (e) => events.push(e) },
              async (args) => {
                await enqueueTask(owned, {
                  projectId: task.projectId,
                  type: "REEMBED",
                  payload: { belief_version_id: args.beliefVersionId },
                  idempotencyKey: `embed:${args.beliefVersionId}`,
                });
              },
              (next) => {
                phase = next;
              },
            );
            await owned
              .update(messages)
              .set({ extractedAt: sql`clock_timestamp()` })
              .where(eq(messages.id, message.id));
            context.checkpoint();
          });
          context.checkpoint();
        });
        for (const event of events) emitDebugTrace(opts.debugTrace, event);
      } catch (error) {
        if (conversationId)
          emitDebugTrace(opts.debugTrace, {
            event: "memory.write.failed",
            target_id: task.payload.evidence_id!,
            detail: { project_id: task.projectId, conversation_id: conversationId, phase },
          });
        throw error;
      }
    },
    REEMBED: async (task, context) => {
      context.checkpoint();
      const id = task.payload.belief_version_id;
      if (task.type !== "REEMBED" || !id) throw Error("invalid embedding task");
      const read = async (db: PostgresJsDatabase) => {
        const [row] = await db
          .select({ version: beliefVersions, belief: beliefs })
          .from(beliefVersions)
          .innerJoin(beliefs, eq(beliefVersions.beliefId, beliefs.id))
          .where(and(eq(beliefVersions.id, id), eq(beliefs.projectId, task.projectId)))
          .limit(1);
        if (!row) throw Error("invalid embedding scope");
        return row;
      };
      const before = await read(db);
      const prepared = await prepareBeliefEmbedding(
        db,
        key,
        {
          beliefVersionId: id,
          subject: before.belief.subject,
          attribute: before.belief.attribute,
          value: before.version.value,
        },
        { ...opts, signal: context.signal },
      );
      context.checkpoint();
      await db.transaction(async (tx) => {
        await projectLock(tx, task.projectId);
        await tx
          .select({ id: beliefVersions.id })
          .from(beliefVersions)
          .where(eq(beliefVersions.id, id))
          .for("update");
        await completeTaskWith(tx, task, async (owned) => {
          const current = await read(owned);
          if (
            current.belief.subject !== before.belief.subject ||
            current.belief.attribute !== before.belief.attribute ||
            JSON.stringify(current.version.value) !== JSON.stringify(before.version.value)
          )
            throw Error("embedding source changed");
          await owned.delete(memoryEmbeddings).where(eq(memoryEmbeddings.beliefVersionId, id));
          await owned.insert(memoryEmbeddings).values({ id: uuidv7(), ...prepared });
          context.checkpoint();
        });
        context.checkpoint();
      });
    },
  };
}
