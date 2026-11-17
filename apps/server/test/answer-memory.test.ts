import { expect, it } from "vitest";
import { answerMemories } from "../src/chat/answer-memory.js";
import { memoryContent, renderMemoryContext } from "../src/retrieval/context-budget.js";
import type { RetrieveResult } from "../src/retrieval/search.js";
const id = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, "0")}`;
function fixture(): RetrieveResult {
  const m = {
    subject: "app",
    attribute: "db",
    value: { engine: "SQLite" },
    provenance: {
      kind: "observation_replay" as const,
      projectId: id(1),
      beliefId: id(2),
      anchorVersionId: id(3),
      observationId: id(4),
      evidenceId: id(5),
      validFrom: "2025-01-01T00:00:00Z",
    },
  };
  return {
    traceId: id(6),
    abstained: false,
    candidates: [
      {
        beliefId: id(2),
        beliefVersionId: id(3),
        subject: "app",
        attribute: "db",
        value: "old",
        vectorScore: null,
        keywordScore: 1,
        fusedScore: 1,
        selected: true,
        reason: "top_k",
      },
    ],
    readTimeContext: {
      text: renderMemoryContext([memoryContent(m)]),
      memories: [m],
      outcomes: [],
      abstained: false,
    },
  };
}
it.each(["project", "anchor", "duplicate", "text", "abstention", "id"])(
  "rejects incoherent replay %s with fixed errors",
  (kind) => {
    const r = fixture();
    const c = r.readTimeContext!;
    if (kind === "project") c.memories[0]!.provenance.projectId = id(99);
    if (kind === "anchor") c.memories[0]!.provenance.anchorVersionId = id(99);
    if (kind === "duplicate") c.memories.push(c.memories[0]!);
    if (kind === "text") c.text = "private-corrupt-sentinel";
    if (kind === "abstention") c.abstained = true;
    if (kind === "id") c.memories[0]!.provenance.evidenceId = "sk-private-sentinel";
    expect(() => answerMemories(r, id(1))).toThrow(new Error("INVALID_REPLAY_ANSWER_CONTEXT"));
  },
);
it("detaches selected values before model waits", () => {
  const r = fixture();
  const out = answerMemories(r, id(1));
  (r.readTimeContext!.memories[0]!.value as { engine: string }).engine = "mutated";
  expect(out.memories[0]?.value).toEqual({ engine: "SQLite" });
});
it("empty replay stays empty even when ranked anchors exist", () => {
  const r = fixture();
  r.readTimeContext = {
    text: renderMemoryContext([]),
    memories: [],
    outcomes: [],
    abstained: true,
  };
  expect(answerMemories(r, id(1))).toEqual({ memories: [], abstained: true });
});

it.each(["count", "entry", "block"])(
  "enforces exact %s boundary and rejects one more",
  (boundary) => {
    function make(extra: number) {
      const r = fixture();
      const template = r.readTimeContext!.memories[0]!;
      const n = boundary === "count" ? 32 + extra : boundary === "block" ? 5 : 1;
      const memories = Array.from({ length: n }, (_, i) => ({
        ...template,
        value: boundary === "block" ? "x".repeat(13000) : "x",
        provenance: { ...template.provenance, anchorVersionId: id(i + 10) },
      }));
      if (boundary === "entry")
        memories[0]!.value = "x".repeat(
          16384 + extra - Buffer.byteLength(memoryContent({ ...template, value: "" }), "utf8"),
        );
      if (boundary === "block") {
        const size = Buffer.byteLength(renderMemoryContext(memories.map(memoryContent)), "utf8");
        memories[n - 1]!.value = String(memories[n - 1]!.value) + "x".repeat(65536 + extra - size);
      }
      r.candidates = memories.map((m) => ({
        ...r.candidates[0]!,
        beliefVersionId: m.provenance.anchorVersionId,
      }));
      r.readTimeContext = {
        memories,
        text: renderMemoryContext(memories.map(memoryContent)),
        outcomes: [],
        abstained: false,
      };
      return r;
    }
    expect(() => answerMemories(make(0), id(1))).not.toThrow();
    expect(() => answerMemories(make(1), id(1))).toThrow(
      new Error("INVALID_REPLAY_ANSWER_CONTEXT"),
    );
  },
);
