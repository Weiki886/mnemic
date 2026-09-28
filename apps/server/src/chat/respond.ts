import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateText } from "ai";
import { uuidv7 } from "uuidv7";
import { conversations, messages } from "../db/schema.js";
import { resolveModel, type ResolveOptions } from "../providers/slots.js";
import { retrieve, type RetrievalCandidate } from "../retrieval/search.js";
import { buildChatSystemPrompt } from "./prompt.js";
import { runExtractionWriteback } from "./writeback.js";

/** 消息应答编排（#7）：存消息 → 检索注入 → 模型回答 → 存回答 → 异步写记忆 */

export interface MemoryRef {
  belief_id: string;
  belief_version_id: string;
  subject: string;
  attribute: string;
  value: unknown;
}

export type RespondResult =
  | { kind: "not_found" }
  | { kind: "ended" }
  | { kind: "answered"; messageId: string; answer: string; memories: MemoryRef[]; abstained: boolean };

export interface RespondOptions extends ResolveOptions {
  onJob: (job: () => Promise<void>) => void;
  /** 测试注入检索替身（阈值放宽/故障注入）；缺省真实两路混合检索 */
  retrieveFn?: typeof retrieve;
  logger?: { warn: (obj: object, msg: string) => void };
}

function toMemoryRef(c: RetrievalCandidate): MemoryRef {
  return {
    belief_id: c.beliefId,
    belief_version_id: c.beliefVersionId,
    subject: c.subject,
    attribute: c.attribute,
    value: c.value,
  };
}

export async function respondToMessage(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  conversationId: string,
  text: string,
  options: RespondOptions,
): Promise<RespondResult> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conv) return { kind: "not_found" };
  if (conv.endedAt) return { kind: "ended" };

  const userMessageId = uuidv7();
  await db.insert(messages).values({
    id: userMessageId,
    conversationId,
    speaker: "user",
    rawText: text,
    msgTime: new Date(),
  });

  // 检索（#6）；检索失败降级为无记忆回答，不阻塞对话
  let candidates: RetrievalCandidate[] = [];
  let abstained = true;
  try {
    const r = await (options.retrieveFn ?? retrieve)(db, masterKey, conv.projectId, text, options);
    candidates = r.candidates;
    abstained = r.abstained;
  } catch (err) {
    options.logger?.warn({ err, conversationId }, "retrieval failed, degrade to no-memory answer");
  }

  const { model } = await resolveModel(db, masterKey, "chat", options);
  const { text: answer } = await generateText({
    model,
    system: buildChatSystemPrompt(candidates),
    prompt: text,
  });

  const assistantMessageId = uuidv7();
  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId,
    speaker: "assistant",
    rawText: answer,
    msgTime: new Date(),
  });

  // 异步写记忆：单条消息提取，证据锚定该用户消息
  const projectId = conv.projectId;
  options.onJob(() =>
    runExtractionWriteback(db, masterKey, { projectId, text, evidenceId: userMessageId }, options).then(() => undefined),
  );

  return {
    kind: "answered",
    messageId: assistantMessageId,
    answer,
    memories: candidates.map(toMemoryRef),
    abstained,
  };
}
