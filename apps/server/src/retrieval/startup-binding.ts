import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  captureChatRetrievalBinding,
  ChatBudgetModelSchema,
  type ChatRetrievalBinding,
} from "./chat-binding.js";
import { MemoryTokenLimitSchema } from "./context-budget.js";
import { loadLocalTokenizer } from "./local-tokenizer.js";
import { captureRecallBinding } from "./recall-binding.js";
import type { ReplayRetrievalBinding } from "./replay-binding.js";

const LocalAsset = z.string().refine(isAbsolute);
const StartupChatMemoryBudget = ChatBudgetModelSchema.extend({
  maxTokens: MemoryTokenLimitSchema,
  tokenizerFile: LocalAsset,
  tokenizerConfigFile: LocalAsset,
}).optional();

export function resolveStartupRetrievalBindings(
  raw: string | undefined,
  dependencies: { databaseConfigured: boolean; masterKey?: Buffer },
): Readonly<{
  recallBinding?: ReplayRetrievalBinding;
  chatRetrievalBinding?: ChatRetrievalBinding;
}> {
  if (raw === undefined || raw === "") return Object.freeze({});
  let recallBinding: ReplayRetrievalBinding;
  let chatRetrievalBinding: ChatRetrievalBinding;
  let budget: z.infer<typeof StartupChatMemoryBudget>;
  try {
    if (Buffer.byteLength(raw, "utf8") > 8192) throw Error();
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error();
    const { chatReadTimeResolution, recallReadTimeResolution, chatMemoryBudget, ...base } =
      input as Record<string, unknown>;
    if (
      (chatReadTimeResolution !== undefined && chatReadTimeResolution !== true) ||
      (recallReadTimeResolution !== undefined && recallReadTimeResolution !== true)
    )
      throw Error();
    budget = StartupChatMemoryBudget.parse(chatMemoryBudget);
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
  if (budget) {
    try {
      const { maxTokens, providerId, modelId, tokenizerFile, tokenizerConfigFile } = budget;
      const bound = captureChatRetrievalBinding({
        ...chatRetrievalBinding,
        memoryBudget: {
          maxTokens,
          countTokens: loadLocalTokenizer(tokenizerFile, tokenizerConfigFile),
        },
        memoryBudgetModel: { providerId, modelId },
      });
      if (!bound) throw Error();
      chatRetrievalBinding = bound;
    } catch {
      throw Error("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
    }
  }
  return Object.freeze({ recallBinding, chatRetrievalBinding });
}
