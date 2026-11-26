import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  captureChatRetrievalBinding,
  ChatBudgetModelSchema,
  type ChatRetrievalBinding,
} from "./chat-binding.js";
import { MemoryTokenLimitSchema } from "./context-budget.js";
import { loadLocalTokenizer } from "./local-tokenizer.js";
import type { ManagedRetrievalBinding } from "./managed-binding.js";
import { captureRecallBinding } from "./recall-binding.js";

const LocalAsset = z.string().refine(isAbsolute);
const StartupMemoryBudget = z
  .object({
    maxTokens: MemoryTokenLimitSchema,
    tokenizerFile: LocalAsset,
    tokenizerConfigFile: LocalAsset,
  })
  .strict();
const StartupRecallMemoryBudget = StartupMemoryBudget.optional();
const StartupChatMemoryBudget = StartupMemoryBudget.merge(ChatBudgetModelSchema).optional();

function loadMemoryBudget({
  maxTokens,
  tokenizerFile,
  tokenizerConfigFile,
}: z.infer<typeof StartupMemoryBudget>) {
  return Object.freeze({
    maxTokens,
    countTokens: loadLocalTokenizer(tokenizerFile, tokenizerConfigFile),
  });
}

export function resolveStartupRetrievalBindings(
  raw: string | undefined,
  dependencies: { databaseConfigured: boolean; masterKey?: Buffer },
): Readonly<{
  recallBinding?: ManagedRetrievalBinding;
  chatRetrievalBinding?: ChatRetrievalBinding;
}> {
  if (raw === undefined || raw === "") return Object.freeze({});
  let recallBinding: ManagedRetrievalBinding;
  let chatRetrievalBinding: ChatRetrievalBinding;
  let chatBudget: z.infer<typeof StartupChatMemoryBudget>;
  let recallBudget: z.infer<typeof StartupRecallMemoryBudget>;
  try {
    if (Buffer.byteLength(raw, "utf8") > 8192) throw Error();
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error();
    const {
      chatReadTimeResolution,
      recallReadTimeResolution,
      chatMemoryBudget,
      recallMemoryBudget,
      ...base
    } = input as Record<string, unknown>;
    if (
      (chatReadTimeResolution !== undefined && chatReadTimeResolution !== true) ||
      (recallReadTimeResolution !== undefined && recallReadTimeResolution !== true)
    )
      throw Error();
    chatBudget = StartupChatMemoryBudget.parse(chatMemoryBudget);
    recallBudget = StartupRecallMemoryBudget.parse(recallMemoryBudget);
    const parsed = captureRecallBinding(base);
    if (!parsed) throw Error();
    const replay = Object.freeze({ ...parsed, readTimeResolution: true as const });
    recallBinding = recallReadTimeResolution === true ? replay : parsed;
    chatRetrievalBinding = chatReadTimeResolution === true ? replay : parsed;
  } catch {
    throw Error("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
  }
  if (
    !dependencies.databaseConfigured ||
    !Buffer.isBuffer(dependencies.masterKey) ||
    dependencies.masterKey.length !== 32
  )
    throw Error("retrieval startup requires database and master key");
  try {
    if (recallBudget) {
      recallBinding = Object.freeze({
        ...recallBinding,
        memoryBudget: loadMemoryBudget(recallBudget),
      });
    }
    if (chatBudget) {
      const { providerId, modelId } = chatBudget;
      const bound = captureChatRetrievalBinding({
        ...chatRetrievalBinding,
        memoryBudget: loadMemoryBudget(chatBudget),
        memoryBudgetModel: { providerId, modelId },
      });
      if (!bound) throw Error();
      chatRetrievalBinding = bound;
    }
  } catch {
    throw Error("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
  }
  return Object.freeze({ recallBinding, chatRetrievalBinding });
}
