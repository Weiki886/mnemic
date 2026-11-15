import { captureRecallBinding, type RecallBinding } from "./recall-binding.js";

export function resolveStartupRetrievalBindings(
  raw: string | undefined,
  dependencies: { databaseConfigured: boolean; masterKey?: Buffer },
): Readonly<{ recallBinding?: RecallBinding; chatRetrievalBinding?: RecallBinding }> {
  if (raw === undefined || raw === "") return Object.freeze({});
  let binding: RecallBinding;
  try {
    if (Buffer.byteLength(raw, "utf8") > 8192) throw Error();
    const parsed = captureRecallBinding(JSON.parse(raw));
    if (!parsed) throw Error();
    binding = parsed;
  } catch {
    throw Error("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
  }
  if (
    !dependencies.databaseConfigured ||
    !Buffer.isBuffer(dependencies.masterKey) ||
    dependencies.masterKey.length !== 32
  )
    throw Error("retrieval startup requires database and master key");
  return Object.freeze({ recallBinding: binding, chatRetrievalBinding: binding });
}
