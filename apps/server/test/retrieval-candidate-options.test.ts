import { expect, it } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { readCandidateScores } from "../src/retrieval/candidates.js";
const projectId = "01900000-0000-7000-8000-000000000001";
const base = {
  projectId,
  query: "PG",
  fusion: { mode: "rrf", flags: { ...DEFAULT_FEATURE_FLAGS } },
};
it.each([
  null,
  {},
  { ...base, projectId: "bad" },
  { ...base, extra: 1 },
  { ...base, query: "x".repeat(1001) },
  { ...base, entities: new Array(33).fill("PG") },
  { ...base, entities: [""] },
  { ...base, entities: ["PG\nkey"] },
  { ...base, embedding: { model: "offline", vector: [1] } },
  { ...base, embedding: { model: "", vector: [1, ...new Array(1023).fill(0)] } },
  ...[NaN, Infinity, 0].map((n) => ({
    ...base,
    embedding: { model: "offline", vector: new Array(1024).fill(n) },
  })),
  ...[
    "bad",
    "2026-02-30T00:00:00Z",
    "0000-01-01T00:00:00Z",
    "2026-01-01T00:00:00.1234567Z",
    "2026-01-01T00:00:00+00:00",
  ].map((validAt) => ({ ...base, validAt })),
  { ...base, fusion: { mode: "rrf", flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_time: true } } },
  { ...base, fusion: { mode: "rrf", flags: { ...DEFAULT_FEATURE_FLAGS }, k: 0 } },
])("invalid candidate input %# rejects before any DB access", async (value) => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error("DB must not be touched");
    },
  });
  await expect(readCandidateScores(db, value)).rejects.toThrow("INVALID_RECALL_INPUT");
  expect(reads).toBe(0);
});
it("oversized collections are rejected before per-element validation", async () => {
  const unreadable = new Proxy(new Array(100000), {
    get(target, key) {
      if (key === "0") throw Error("element must not be inspected");
      return Reflect.get(target, key);
    },
  });
  const db = {} as PostgresJsDatabase;
  await expect(readCandidateScores(db, { ...base, entities: unreadable })).rejects.toThrow(
    "INVALID_RECALL_INPUT",
  );
  await expect(
    readCandidateScores(db, { ...base, embedding: { model: "offline", vector: unreadable } }),
  ).rejects.toThrow("INVALID_RECALL_INPUT");
});
it("all sources disabled or no usable source input returns an empty result without DB or models", async () => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error("must not query");
    },
  });
  const flags = {
    ...DEFAULT_FEATURE_FLAGS,
    retrieval_vector: false,
    retrieval_keyword: false,
    retrieval_entity: false,
    retrieval_time: true,
  };
  expect(
    await readCandidateScores(db, {
      ...base,
      validAt: "2026-01-01T00:00:00.123456Z",
      fusion: { mode: "rrf", flags },
    }),
  ).toEqual([]);
  expect(
    await readCandidateScores(db, { ...base, query: "", embedding: null, entities: [] }),
  ).toEqual([]);
  expect(reads).toBe(0);
});
it("model identifiers have their own 256-character bound rather than inheriting the entity-label bound", async () => {
  const value = {
    ...base,
    fusion: {
      mode: "rrf",
      flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, retrieval_keyword: false },
    },
    embedding: { model: "x".repeat(192), vector: [1, ...new Array(1023).fill(0)] },
  };
  expect(await readCandidateScores({} as PostgresJsDatabase, value)).toEqual([]);
  await expect(
    readCandidateScores({} as PostgresJsDatabase, {
      ...value,
      embedding: { ...value.embedding, model: "x".repeat(257) },
    }),
  ).rejects.toThrow("INVALID_RECALL_INPUT");
});
