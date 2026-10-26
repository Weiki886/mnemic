import { expect, it, vi } from "vitest";
import { createDebugTrace, type DebugEvent } from "../src/debug/trace.js";
import { resolveDebugMode } from "../src/config.js";
const id = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a";
const event: DebugEvent = {
  event: "memory.retrieval.completed",
  target_id: id,
  detail: {
    project_id: id,
    conversation_id: null,
    matched_count: 3,
    selected_count: 1,
    abstained: false,
    reinforce_enabled: false,
  },
};
it("debug is explicit, defaults off and rejects ambiguous values without echoing them", () => {
  expect(resolveDebugMode(undefined)).toBe(false);
  expect(resolveDebugMode("0")).toBe(false);
  expect(resolveDebugMode("1")).toBe(true);
  for (const value of ["", "true", "PRIVATE", " 1 "])
    expect(() => resolveDebugMode(value)).toThrow("MNEMIC_DEBUG 必须为 0 或 1");
});
it("disabled tracing never inspects input or changes control flow", () => {
  const value = new Proxy(
    {},
    {
      get: () => {
        throw new Error("must not inspect");
      },
    },
  );
  expect(() => createDebugTrace()(value as DebugEvent)).not.toThrow();
});
it("writes structured ts/event/target_id/detail JSONL using an allowlist, not free text", () => {
  const lines: string[] = [],
    debug = vi.fn((fields, msg) => {
      lines.push(JSON.stringify({ ...fields, msg }));
    });
  createDebugTrace({ debug })(event);
  expect(debug).toHaveBeenCalledOnce();
  expect(JSON.parse(lines[0]!)).toMatchObject({ ...event, msg: "memory debug trace" });
  expect(JSON.parse(lines[0]!).ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(lines[0]).not.toMatch(/query|prompt|raw_text|value|api_key/);
});
it("unknown fields, opaque content, invalid ids and invalid counters fail closed with no log", () => {
  const debug = vi.fn(),
    emit = createDebugTrace({ debug });
  for (const bad of [
    { ...event, prompt: "PRIVATE" },
    { ...event, target_id: "sk-01234567890123456789" },
    { ...event, detail: { ...event.detail, api_key: "OPAQUE-PRIVATE" } },
    { ...event, detail: { ...event.detail, matched_count: -1 } },
  ])
    emit(bad as DebugEvent);
  expect(debug).not.toHaveBeenCalled();
});
it("logger failures never escape and parsed copies cannot mutate caller-owned detail", () => {
  const source = structuredClone(event);
  const emit = createDebugTrace({
    debug: (fields) => {
      fields.detail.project_id = "changed";
      throw new Error("logger");
    },
  });
  expect(() => emit(source)).not.toThrow();
  expect(source).toEqual(event);
});
