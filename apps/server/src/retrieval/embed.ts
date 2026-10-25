import { embed } from "ai";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import {
  beliefs,
  beliefVersions,
  conversations,
  messages,
  observations,
  memoryEmbeddings,
} from "../db/schema.js";
import { eq } from "drizzle-orm";
import { resolveModel, type ResolveOptions } from "../providers/slots.js";

/**
 * 版本文本的嵌入入库（#6 写入侧）。
 * 文本形态 = "subject attribute: value"（拼上主语/属性提升召回相关度）。
 * 由 #16 ingest 在新版本产生后调用（deps.indexEmbedding 注入；未注入则不索引）。
 */
export async function indexBeliefVersion(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  args: { beliefVersionId: string; subject: string; attribute: string; value: unknown },
  options: ResolveOptions = {},
): Promise<void> {
  const text = `${args.subject} ${args.attribute}: ${
    typeof args.value === "string" ? args.value : JSON.stringify(args.value)
  }`;
  const [scope] = await db
    .select({ projectId: beliefs.projectId, conversationId: conversations.id })
    .from(beliefVersions)
    .innerJoin(beliefs, eq(beliefVersions.beliefId, beliefs.id))
    .leftJoin(observations, eq(beliefVersions.sourceObservationId, observations.id))
    .leftJoin(messages, eq(observations.evidenceId, messages.id))
    .leftJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(eq(beliefVersions.id, args.beliefVersionId))
    .limit(1);
  if (!scope) throw new Error("invalid embedding usage scope");
  const { model, modelId } = await resolveModel(db, masterKey, "embedding", {
    ...options,
    usageContext: { ...scope, purpose: "embedding_index" },
  });
  const { embedding } = await embed({ model, value: text });
  await db.insert(memoryEmbeddings).values({
    id: uuidv7(),
    beliefVersionId: args.beliefVersionId,
    embedding,
    model: modelId,
  });
}
