import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateText } from "ai";
import { uuidv7 } from "uuidv7";
import { conversations, messages } from "../db/schema.js";
import { resolveModel, type ResolveOptions } from "../providers/slots.js";
import { retrieve, type RetrievalCandidate } from "../retrieval/search.js";
import { buildChatSystemPrompt } from "./prompt.js";
import { claimMessageForExtraction, runExtractionWriteback } from "./writeback.js";
import { ConversationContextError, loadConversationMessages, modelHistory } from "./context.js";
import type { ProjectAttachment } from "@mnemic/shared/file-context";
import { currentUserContent, prepareFileEvidence } from "./attachments.js";
import { writeAuditLog } from "../gate/audit.js";

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
  | { kind: "context_invalid" }
  | {
      kind: "answered";
      messageId: string;
      answer: string;
      memories: MemoryRef[];
      abstained: boolean;
      historyIncluded: boolean;
    };

export interface RespondOptions extends ResolveOptions {
  onJob: (job: () => Promise<void>) => void;
  /** 测试注入检索替身（阈值放宽/故障注入）；缺省真实两路混合检索 */
  retrieveFn?: typeof retrieve;
  logger?: { warn: (obj: object, msg: string) => void };
}

export function toMemoryRef(c: RetrievalCandidate): MemoryRef {
  return {
    belief_id: c.beliefId,
    belief_version_id: c.beliefVersionId,
    subject: c.subject,
    attribute: c.attribute,
    value: c.value,
  };
}

export async function enterMessage(
  db: PostgresJsDatabase,
  conversationId: string,
  text: string,
  projectId?: string,
  attachments: ProjectAttachment[] = [],
) {
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
    if (!conv || (projectId && conv.projectId !== projectId)) return { kind: "not_found" } as const;
    if (conv.endedAt) return { kind: "ended" } as const;
    let history;
    try {
      history = await loadConversationMessages(tx, conv);
    } catch (error) {
      if (!(error instanceof ConversationContextError)) throw error;
      return { kind: "context_invalid" } as const;
    }
    await tx.insert(messages).values({
      id: userMessageId,
      conversationId,
      speaker: "user",
      rawText: text,
      msgTime: new Date(),
    });
    const files = [];
    for (const input of attachments) {
      const file = prepareFileEvidence(input, userMessageId);
      const id = uuidv7();
      await tx.insert(messages).values({
        id,
        conversationId,
        speaker: "tool",
        rawText: file.rawText,
        attachment: file.attachment,
        msgTime: new Date(),
      });
      for (const hit of file.hits)
        await writeAuditLog(tx, {
          actor: "gate",
          action: "redact",
          target: id,
          decision: "redacted",
          meta: { pattern: hit.pattern, count: hit.count },
        });
      files.push({ id, rawText: file.rawText, attachment: file.attachment });
    }
    return {
      kind: "ok" as const,
      projectId: conv.projectId,
      conversationId,
      history,
      userMessageId,
      files,
    };
  });
  return entered;
}

export type EnteredMessage = Extract<Awaited<ReturnType<typeof enterMessage>>, { kind: "ok" }>;

export async function prepareAnswer(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  text: string,
  entered: EnteredMessage,
  options: RespondOptions,
) {
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
    options.logger?.warn(
      { err, conversationId: entered.conversationId },
      "retrieval failed, degrade to no-memory answer",
    );
  }

  const { model } = await resolveModel(db, masterKey, "chat", options);
  const history = await modelHistory(db, entered.projectId, entered.history);
  return {
    model,
    candidates,
    abstained,
    history,
    system: buildChatSystemPrompt(candidates, history.length > 0, entered.files.length > 0),
    userContent: currentUserContent(text, entered.files),
  };
}

export async function saveAnswer(
  db: PostgresJsDatabase,
  conversationId: string,
  assistantMessageId: string,
  answer: string,
  candidates: RetrievalCandidate[],
  generationStatus?: "complete" | "interrupted" | "failed",
) {
  const saved = await db.transaction(async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for("update")
      .limit(1);
    // Another client may have archived/resumed while generation was in flight. Never append to the archived source.
    if (!conv || conv.endedAt) return false;
    await tx.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      speaker: "assistant",
      rawText: answer,
      msgTime: new Date(),
      // 引用留痕（#8）：只存版本 ID，内容读出时现查（决策 8 引用不复制）
      memories: candidates.length > 0 ? candidates.map((c) => c.beliefVersionId) : null,
      generationStatus: generationStatus ?? null,
    });
    return true;
  });
  return saved;
}

export async function scheduleMessageWriteback(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  entered: EnteredMessage,
  text: string,
  options: RespondOptions,
) {
  // 异步写记忆：先认领再提取（认领失败 = 并发 commit 已接管，无需重复提取）
  const projectId = entered.projectId;
  for (const evidence of [
    { id: entered.userMessageId, text, channel: undefined },
    ...entered.files.map((file) => ({
      id: file.id,
      text: file.rawText,
      channel: "project-file" as const,
    })),
  ]) {
    if (await claimMessageForExtraction(db, evidence.id)) {
      options.onJob(() =>
        runExtractionWriteback(
          db,
          masterKey,
          {
            projectId,
            text: evidence.text,
            evidenceId: evidence.id,
            ...(evidence.channel ? { channel: evidence.channel } : {}),
          },
          options,
        ).then(() => undefined),
      );
    }
  }
}

export async function respondToMessage(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  projectId: string,
  conversationId: string,
  text: string,
  options: RespondOptions,
  attachments: ProjectAttachment[] = [],
): Promise<RespondResult> {
  const entered = await enterMessage(db, conversationId, text, projectId, attachments);
  if (entered.kind !== "ok") return { kind: entered.kind };
  const { model, candidates, abstained, history, system, userContent } = await prepareAnswer(
    db,
    masterKey,
    text,
    entered,
    options,
  );
  const { text: answer } = await generateText({
    model,
    system,
    messages: [...history, { role: "user", content: userContent }],
  });
  const assistantMessageId = uuidv7();
  if (!(await saveAnswer(db, conversationId, assistantMessageId, answer, candidates)))
    return { kind: "ended" };
  await scheduleMessageWriteback(db, masterKey, entered, text, options);

  return {
    kind: "answered",
    messageId: assistantMessageId,
    answer,
    memories: candidates.map(toMemoryRef),
    abstained,
    historyIncluded: history.length > 0,
  };
}
