import { expect, it } from "vitest";
import { captureChatRetrievalBinding } from "../src/retrieval/chat-binding.js";
import { captureRecallBinding } from "../src/retrieval/recall-binding.js";
const base = { fusion: { mode: "rrf", threshold: 0.001 }, rerankerProvider: {} };
it("freezes a chat-only capability without exposing it to recall", () => {
  const mutable = { ...base, fusion: { ...base.fusion }, readTimeResolution: true };
  const bound = captureChatRetrievalBinding(mutable)!;
  mutable.readTimeResolution = false;
  mutable.fusion.threshold = 0.9;
  expect(bound.readTimeResolution).toBe(true);
  expect(bound.fusion.threshold).toBe(0.001);
  expect(Object.isFrozen(bound)).toBe(true);
  expect(() => captureRecallBinding({ ...base, readTimeResolution: true })).toThrow(
    "INVALID_RECALL_BINDING",
  );
});
it.each([false, null, 0, "true"])(
  "rejects malformed replay capability %j",
  (readTimeResolution) => {
    expect(() => captureChatRetrievalBinding({ ...base, readTimeResolution })).toThrow(
      "INVALID_RECALL_BINDING",
    );
  },
);
it.each(["flagsSnapshot", "reinforce", "apiKey", "topK"])(
  "rejects untrusted overrides %s",
  (key) => {
    expect(() => captureChatRetrievalBinding({ ...base, [key]: true })).toThrow(
      "INVALID_RECALL_BINDING",
    );
  },
);
it("retains absent/legacy behavior", () => {
  expect(captureChatRetrievalBinding(undefined)).toBeUndefined();
  expect(captureChatRetrievalBinding(base)).not.toHaveProperty("readTimeResolution");
});
