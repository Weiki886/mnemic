import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateText } from "ai";
import { uuidv7 } from "uuidv7";
import { conversations, messages } from "../db/schema.js";
import { resolveModel, type ResolveOptions } from "../providers/slots.js";
import { retrieve, type RetrievalCandidate } from "../retrieval/search.js";
import { buildChatSystemPrompt } from "./prompt.js";
import { claimMessageForExtraction, runExtractionWriteback } from "./writeback.js";

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
  | {
      kind: "answered";
      messageId: string;
      answer: string;
      memories: MemoryRef[];
      abstained: boolean;
    };

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
  const userMessageId = uuidv7();
  // 会话行锁内完成"未提交检查 + 写入消息"：与并发 commit 互斥，
  // 要么先于 commit 写入（commit 会提取它），要么看到已提交直接 409，不留孤儿消息
  const entered = await db.transaction(async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for("update")
      .limit(1);
    if (!conv) return { kind: "not_found" } as const;
    if (conv.endedAt) return { kind: "ended" } as const;
    await tx.insert(messages).values({
      id: userMessageId,
      conversationId,
      speaker: "user",
      rawText: text,
      msgTime: new Date(),
    });
    return { kind: "ok" as const, projectId: conv.projectId };
  });
  if (entered.kind !== "ok") return { kind: entered.kind };

  // 检索（#6）；检索失败降级为无记忆回答，不阻塞对话
  let candidates: RetrievalCandidate[] = [];
  let abstained = true;
  try {
    const r = await (options.retrieveFn ?? retrieve)(
      db,
      masterKey,
      entered.projectId,
      text,
      options,
    );
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
    // 引用留痕（#8）：只存版本 ID，内容读出时现查（决策 8 引用不复制）
    memories: candidates.length > 0 ? candidates.map((c) => c.beliefVersionId) : null,
  });

  // 异步写记忆：先认领再提取（认领失败 = 并发 commit 已接管，无需重复提取）
  const projectId = entered.projectId;
  if (await claimMessageForExtraction(db, userMessageId)) {
    options.onJob(() =>
      runExtractionWriteback(
        db,
        masterKey,
        { projectId, text, evidenceId: userMessageId },
        options,
      ).then(() => undefined),
    );
  }

  return {
    kind: "answered",
    messageId: assistantMessageId,
    answer,
    memories: candidates.map(toMemoryRef),
    abstained,
  };
}
