import { expect, it, vi } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { extractCandidates } from "../src/extraction/extractor.js";
it("already aborted extraction makes zero SDK calls", async () => {
  const call = vi.fn();
  const model = new MockLanguageModelV2({ doGenerate: call });
  await expect(extractCandidates(model, "text", { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});
it("cancellation after SDK invocation never enters feedback retry or returns degradation", async () => {
  const controller = new AbortController();
  const call = vi.fn(async () => {
    controller.abort();
    throw Error("cancelled");
  });
  await expect(
    extractCandidates(new MockLanguageModelV2({ doGenerate: call }), "text", {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});
