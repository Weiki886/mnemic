import { captureRecallBinding } from "./recall-binding.js";
import type { ReplayRetrievalBinding } from "./replay-binding.js";

export function resolveStartupRetrievalBindings(
  raw: string | undefined,
  dependencies: { databaseConfigured: boolean; masterKey?: Buffer },
): Readonly<{
  recallBinding?: ReplayRetrievalBinding;
  chatRetrievalBinding?: ReplayRetrievalBinding;
}> {
  if (raw === undefined || raw === "") return Object.freeze({});
  let recallBinding: ReplayRetrievalBinding;
  let chatRetrievalBinding: ReplayRetrievalBinding;
  try {
    if (Buffer.byteLength(raw, "utf8") > 8192) throw Error();
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error();
    const { chatReadTimeResolution, recallReadTimeResolution, ...base } = input as Record<
      string,
      unknown
    >;
    if (
      (chatReadTimeResolution !== undefined && chatReadTimeResolution !== true) ||
      (recallReadTimeResolution !== undefined && recallReadTimeResolution !== true)
    )
      throw Error();
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
  return Object.freeze({ recallBinding, chatRetrievalBinding });
}
