import { expect, it, vi } from "vitest";
import { packMemoryContext, renderMemoryContext } from "../src/retrieval/context-budget.js";

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const entry = (n: number, extra = {}) => ({
  beliefVersionId: id(n),
  salience: 0.5,
  recordedFrom: "2026-01-01T00:00:00Z",
  content: `memory-${n}`,
  ...extra,
});
// Deterministic offline counters test packing, not a claim about any provider's tokenizer.
const onePerEntry = (s: string) => (s === "（无相关记忆）" ? 0 : s.split("\n").length);

it("orders by salience, then full microsecond recorded_from, then UUID; missing salience is last", () => {
  const candidates = [
    entry(1, { salience: null, recordedFrom: "2099-01-01T00:00:00Z" }),
    entry(2, { salience: 0 }),
    entry(3, { recordedFrom: "2026-01-01T00:00:00.123455Z" }),
    entry(5, { recordedFrom: "2026-01-01T00:00:00.123456Z" }),
    entry(4, { recordedFrom: "2026-01-01T00:00:00.123456Z" }),
    entry(6, { salience: 1, recordedFrom: "2020-01-01T00:00:00Z" }),
  ];
  const result = packMemoryContext({ maxTokens: 6, candidates }, onePerEntry);
  expect(result.selectedIds).toEqual([6, 4, 5, 3, 2, 1].map(id));
  expect(result.text).toBe(
    "[1] memory-6\n[2] memory-4\n[3] memory-5\n[4] memory-3\n[5] memory-2\n[6] memory-1",
  );
  expect(result.tokenCount).toBe(6);
  expect(result.discarded).toEqual([]);
  expect(candidates.map((c) => c.beliefVersionId)).toEqual([1, 2, 3, 5, 4, 6].map(id));
});
it("normalizes fractional precision for ordering without dropping submillisecond digits", () => {
  const candidates = [
    entry(1, { recordedFrom: "2026-01-01T00:00:00.1Z" }),
    entry(2, { recordedFrom: "2026-01-01T00:00:00.100000Z" }),
    entry(3, { recordedFrom: "2026-01-01T00:00:00.100001Z" }),
  ];
  expect(packMemoryContext({ maxTokens: 3, candidates }, onePerEntry).selectedIds).toEqual(
    [3, 1, 2].map(id),
  );
});
it("accepts an exact budget boundary and records only discarded IDs and reasons", () => {
  const result = packMemoryContext(
    { maxTokens: 2, candidates: [entry(3), entry(1), entry(2)] },
    onePerEntry,
  );
  expect(result).toEqual({
    text: "[1] memory-1\n[2] memory-2",
    tokenCount: 2,
    selectedIds: [id(1), id(2)],
    discarded: [{ beliefVersionId: id(3), reason: "token_budget" }],
  });
  expect(JSON.stringify(result.discarded)).not.toContain("memory-3");
});
it("keeps a priority prefix, never leapfrogs an overflowing high-priority memory with a smaller one", () => {
  const counter = vi.fn((s: string) =>
    s === "（无相关记忆）" ? 0 : s.includes("too-big") ? 100 : 1,
  );
  const result = packMemoryContext(
    { maxTokens: 2, candidates: [entry(3), entry(2, { content: "too-big" }), entry(1)] },
    counter,
  );
  expect(result.selectedIds).toEqual([id(1)]);
  expect(result.discarded).toEqual(
    [2, 3].map((n) => ({ beliefVersionId: id(n), reason: "token_budget" })),
  );
  expect(counter.mock.calls.map(([s]) => s)).toEqual([
    "（无相关记忆）",
    "[1] memory-1",
    "[1] memory-1\n[2] too-big",
  ]);
});
it("counts full rendered prefixes including numbering and separators rather than summing standalone counts", () => {
  const counter = vi.fn((s: string) => {
    if (s === "（无相关记忆）") return 2;
    return s.includes("\n") ? 7 : 4;
  });
  const result = packMemoryContext({ maxTokens: 7, candidates: [entry(1), entry(2)] }, counter);
  expect(result.tokenCount).toBe(7);
  expect(result.selectedIds).toEqual([id(1), id(2)]);
  expect(counter).toHaveBeenLastCalledWith(result.text);
});
it("counts the empty marker too and fails if even the empty block exceeds budget", () => {
  expect(packMemoryContext({ maxTokens: 3, candidates: [] }, () => 3)).toEqual({
    text: "（无相关记忆）",
    tokenCount: 3,
    selectedIds: [],
    discarded: [],
  });
  expect(() => packMemoryContext({ maxTokens: 2, candidates: [] }, () => 3)).toThrow(
    /^MEMORY_BUDGET_TOO_SMALL$/,
  );
  expect(
    packMemoryContext({ maxTokens: 0, candidates: [entry(1)] }, onePerEntry).discarded,
  ).toEqual([{ beliefVersionId: id(1), reason: "token_budget" }]);
});
it("copies all inputs before invoking the counter, preventing callback mutation from changing decisions", () => {
  const candidates = [entry(2), entry(1)];
  const input = { maxTokens: 1, candidates };
  const result = packMemoryContext(input, (text) => {
    input.maxTokens = 100;
    candidates[0]!.content = "changed";
    candidates[0]!.salience = 1;
    candidates.reverse();
    return onePerEntry(text);
  });
  expect(result.text).toBe("[1] memory-1");
  expect(result.selectedIds).toEqual([id(1)]);
  expect(result.discarded).toEqual([{ beliefVersionId: id(2), reason: "token_budget" }]);
});
it("renders literal content with stable numbering and preserves Unicode, newlines and JSON punctuation", () => {
  expect(renderMemoryContext([])).toBe("（无相关记忆）");
  expect(renderMemoryContext(['项目 / DB = {"中文":"🧠"}', "line1\nline2"])).toBe(
    '[1] 项目 / DB = {"中文":"🧠"}\n[2] line1\nline2',
  );
});
it.each([
  null,
  {},
  { maxTokens: -1, candidates: [] },
  { maxTokens: 0.5, candidates: [] },
  { maxTokens: 1000001, candidates: [] },
  { maxTokens: 1, candidates: [], extra: "secret" },
  ...[
    { beliefVersionId: "secret" },
    { salience: -1 },
    { salience: 1.1 },
    { salience: NaN },
    { salience: "0.5" },
    { recordedFrom: "2026-02-30T00:00:00Z" },
    { recordedFrom: "0000-01-01T00:00:00Z" },
    { recordedFrom: "2026-01-01T00:00:00+00:00" },
    { recordedFrom: "2026-01-01T00:00:00.1234567Z" },
    { content: "" },
    { content: "x".repeat(16385) },
    { content: "中".repeat(5462) },
    { content: "bad\ud800" },
    { content: "bad\0" },
    { extra: "secret" },
  ].map((extra) => ({ maxTokens: 1, candidates: [entry(1, extra)] })),
  { maxTokens: 1, candidates: [entry(1), entry(1)] },
  {
    maxTokens: 1,
    candidates: [
      entry(1, { beliefVersionId: "01900000-0000-7000-8000-000000abcdef" }),
      entry(2, { beliefVersionId: "01900000-0000-7000-8000-000000ABCDEF" }),
    ],
  },
  {
    maxTokens: 1,
    candidates: Array.from({ length: 5 }, (_, n) => entry(n, { content: "x".repeat(16384) })),
  },
])(
  "rejects malformed/over-limit input %# before token counting, without echoing raw fields",
  (value) => {
    const counter = vi.fn(() => 0);
    expect(() => packMemoryContext(value, counter)).toThrow(/^INVALID_MEMORY_BUDGET_INPUT$/);
    expect(counter).not.toHaveBeenCalled();
  },
);
it("rejects oversized candidate collections before inspecting their elements", () => {
  const candidates = new Proxy(new Array(801), {
    get(target, key) {
      if (key === "0") throw Error("must not inspect elements");
      return Reflect.get(target, key);
    },
  });
  const counter = vi.fn(() => 0);
  expect(() => packMemoryContext({ maxTokens: 1, candidates }, counter)).toThrow(
    /^INVALID_MEMORY_BUDGET_INPUT$/,
  );
  expect(counter).not.toHaveBeenCalled();
});
it("accepts inclusive resource limits: 800 entries and 64KiB of UTF8 content", () => {
  const many = Array.from({ length: 800 }, (_, n) => entry(n, { content: "a" }));
  expect(
    packMemoryContext({ maxTokens: 800, candidates: many }, onePerEntry).selectedIds,
  ).toHaveLength(800);
  const full = Array.from({ length: 4 }, (_, n) => entry(n, { content: "x".repeat(16384) }));
  expect(
    packMemoryContext({ maxTokens: 4, candidates: full }, onePerEntry).selectedIds,
  ).toHaveLength(4);
});
it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, Promise.resolve(1)])(
  "rejects invalid counter result %# without a partial prompt",
  (count) => {
    expect(() =>
      packMemoryContext({ maxTokens: 1, candidates: [entry(1)] }, (() => count) as () => number),
    ).toThrow(/^MEMORY_TOKEN_COUNT_FAILED$/);
  },
);
it("hides counter errors including content or tokenizer internals", () => {
  expect(() =>
    packMemoryContext({ maxTokens: 1, candidates: [entry(1)] }, () => {
      throw Error("sk-secret-raw-text");
    }),
  ).toThrow(/^MEMORY_TOKEN_COUNT_FAILED$/);
});

it("does not return an accepted partial prefix when later token counting fails", () => {
  const counter = (text: string) => {
    if (text.includes("[2]")) throw Error("private tokenizer response");
    return text === "（无相关记忆）" ? 0 : 1;
  };
  expect(() =>
    packMemoryContext({ maxTokens: 2, candidates: [entry(1), entry(2)] }, counter),
  ).toThrow(/^MEMORY_TOKEN_COUNT_FAILED$/);
});
it("accepts leap day and UTC year boundaries without losing timestamp order", () => {
  const candidates = [
    entry(1, { recordedFrom: "0001-01-01T00:00:00Z" }),
    entry(2, { recordedFrom: "2024-02-29T23:59:59.999999Z" }),
    entry(3, { recordedFrom: "9999-12-31T23:59:59.999999Z" }),
  ];
  expect(packMemoryContext({ maxTokens: 3, candidates }, onePerEntry).selectedIds).toEqual(
    [3, 2, 1].map(id),
  );
});
