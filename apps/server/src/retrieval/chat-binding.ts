import { captureRecallBinding, type RecallBinding } from "./recall-binding.js";

export type ChatRetrievalBinding = RecallBinding & Readonly<{ readTimeResolution?: true }>;
/** Chat-only library capability. Recall and official startup retain their stricter parser. */
export function captureChatRetrievalBinding(value: unknown): ChatRetrievalBinding | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    const { readTimeResolution, ...rest } = value as Record<string, unknown>;
    if (readTimeResolution !== undefined && readTimeResolution !== true) throw Error();
    const base = captureRecallBinding(rest);
    if (!base) throw Error();
    return Object.freeze({
      ...base,
      ...(readTimeResolution === true ? { readTimeResolution: true as const } : {}),
    });
  } catch {
    throw Error("INVALID_RECALL_BINDING");
  }
}
