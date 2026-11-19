import { captureChatRetrievalBinding, type ChatRetrievalBinding } from "./chat-binding.js";
import { captureRecallBinding, type RecallBinding } from "./recall-binding.js";

export function resolveStartupRetrievalBindings(
  raw: string | undefined,
  dependencies: { databaseConfigured: boolean; masterKey?: Buffer },
): Readonly<{ recallBinding?: RecallBinding; chatRetrievalBinding?: ChatRetrievalBinding }> {
  if (raw === undefined || raw === "") return Object.freeze({});
  let binding: RecallBinding;
  let chatBinding: ChatRetrievalBinding;
  try {
    if (Buffer.byteLength(raw, "utf8") > 8192) throw Error();
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error();
    const { chatReadTimeResolution, ...base } = input as Record<string, unknown>;
    if (chatReadTimeResolution !== undefined && chatReadTimeResolution !== true) throw Error();
    const parsed = captureRecallBinding(base);
    if (!parsed) throw Error();
    binding = parsed;
    chatBinding =
      chatReadTimeResolution === true
        ? captureChatRetrievalBinding({ ...parsed, readTimeResolution: true })!
        : parsed;
  } catch {
    throw Error("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
  }
  if (
    !dependencies.databaseConfigured ||
    !Buffer.isBuffer(dependencies.masterKey) ||
    dependencies.masterKey.length !== 32
  )
    throw Error("retrieval startup requires database and master key");
  return Object.freeze({ recallBinding: binding, chatRetrievalBinding: chatBinding });
}
