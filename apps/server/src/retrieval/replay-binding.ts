import { captureRecallBinding, type RecallBinding } from "./recall-binding.js";

export type ReplayRetrievalBinding = RecallBinding & Readonly<{ readTimeResolution?: true }>;
/** Trusted library replay capability; base startup parsing remains separate. */
export function captureReplayRetrievalBinding(value: unknown): ReplayRetrievalBinding | undefined {
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
