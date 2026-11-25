import { expect, it } from "vitest";
import { buildApp } from "../src/app.js";
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

it("captures a model pin only for Chat and freezes its identity", () => {
  const providerId = "01920000-0000-7000-8000-00000000000a";
  const memoryBudget = { maxTokens: 100, countTokens: (): number => 1 };
  const memoryBudgetModel = { providerId: providerId.toUpperCase(), modelId: "Case Sensitive" };
  const config = { ...base, memoryBudget, memoryBudgetModel };
  const bound = captureChatRetrievalBinding(config)!;
  memoryBudgetModel.modelId = "changed";
  expect(bound.memoryBudgetModel).toEqual({ providerId, modelId: "Case Sensitive" });
  expect(Object.isFrozen(bound.memoryBudgetModel)).toBe(true);
  expect(() => buildApp({ auth: false, recallBinding: config })).toThrow("INVALID_RECALL_BINDING");
});

it("requires a valid Chat model identity and a budget when pinning", () => {
  const valid = { providerId: "01920000-0000-7000-8000-00000000000a", modelId: "offline" };
  const memoryBudget = { maxTokens: 100, countTokens: (): number => 1 };
  expect(() => captureChatRetrievalBinding({ ...base, memoryBudgetModel: valid })).toThrow(
    "INVALID_CHAT_MEMORY_BUDGET_MODEL",
  );
  for (const memoryBudgetModel of [
    null,
    {},
    { ...valid, providerId: "invalid" },
    { ...valid, modelId: "" },
    { ...valid, extra: true },
  ]) {
    expect(() => captureChatRetrievalBinding({ ...base, memoryBudget, memoryBudgetModel })).toThrow(
      "INVALID_CHAT_MEMORY_BUDGET_MODEL",
    );
  }
});
