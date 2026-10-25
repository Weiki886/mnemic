import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { conversations, modelUsage } from "../db/schema.js";

export interface UsageContext {
  projectId: string | null;
  conversationId: string | null;
  purpose: "chat" | "extraction" | "embedding_query" | "embedding_index" | "probe";
}
export interface UsageRecord extends UsageContext {
  providerName: string;
  modelId: string;
  slot: "chat" | "extraction" | "embedding";
  status: "success" | "error" | "aborted";
  startedAt: Date;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
}

export async function writeModelUsage(db: PostgresJsDatabase, r: UsageRecord): Promise<void> {
  if (r.conversationId) {
    if (!r.projectId) throw new Error("invalid usage scope");
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, r.conversationId), eq(conversations.projectId, r.projectId)))
      .limit(1);
    if (!conv) throw new Error("invalid usage scope");
  }
  // Explicit allowlist: never persist provider responses, error objects, credentials or prompts.
  await db.insert(modelUsage).values({
    id: uuidv7(),
    projectId: r.projectId,
    conversationId: r.conversationId,
    providerName: r.providerName,
    modelId: r.modelId,
    slot: r.slot,
    purpose: r.purpose,
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    reasoningTokens: r.reasoningTokens,
    cachedInputTokens: r.cachedInputTokens,
  });
}
