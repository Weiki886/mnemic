import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createFeatureFlagSnapshot, DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { retrieve } from "../src/retrieval/search.js";
import { buildChatSystemPrompt } from "../src/chat/prompt.js";
import { createProvider } from "../src/providers/repository.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { durableModels } from "./fixtures/durable-models.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb;
const p = uuidv7(),
  providerName = `budget-${uuidv7()}`,
  model = durableModels();
const flags = (extra = {}) =>
  createFeatureFlagSnapshot({
    schema_version: 1,
    revision: 0,
    flags: { ...DEFAULT_FEATURE_FLAGS, retrieval_vector: false, ...extra },
  });
const fusion = {
  mode: "weighted",
  weights: { vector: 0.7, keyword: 0.3, entity: 0, time: 0 },
  threshold: 0.1,
};
// Controlled offline counter, not a claim about any real tokenizer.
const countEntries = (s: string) => (s === "（无相关记忆）" ? 0 : s.split("\n").length);
const options = (memoryBudget: unknown = { maxTokens: 2, countTokens: countEntries }) => ({
  providerName,
  factory: model.factory,
  flagsSnapshot: flags(),
  fusion,
  topK: 5,
  memoryBudget,
});
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects(id,name) values(${p},'budget-runtime')`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: providerName,
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { embedding: "embed" },
  });
}, 180000);
afterEach(async () => {
  model.embedding.mockClear();
  await t.sql`delete from retrieval_traces where project_id=${p}`;
  await t.sql`delete from model_usage where project_id=${p}`;
  await t.sql`update beliefs set current_version_id=null where project_id=${p}`;
  await t.sql`delete from belief_versions where belief_id in(select id from beliefs where project_id=${p})`;
  await t.sql`delete from beliefs where project_id=${p}`;
});
afterAll(async () => {
  if (t) {
    await t.sql`delete from provider_configs where name=${providerName}`;
    await t.sql`delete from projects where id=${p}`;
    await t.close();
  }
});
async function fact(
  salience: number | null,
  recorded = "2026-01-01T00:00:00Z",
  value: unknown = "needle",
  confidence = 0.5,
  valid = "2020-01-01T00:00:00Z",
) {
  const b = uuidv7(),
    v = uuidv7();
  await t.sql`insert into beliefs(id,project_id,subject,attribute,confidence,salience,importance) values(${b},${p},${b},'database',${confidence},${salience},0.1)`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${v},${b},${JSON.stringify(value)}::jsonb,${valid}::timestamptz,${recorded}::timestamptz)`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  return { b, v };
}
async function traces() {
  return t.sql`select * from retrieval_traces where project_id=${p}`;
}
it("runtime shortlist is budgeted by salience, and discarded IDs/reasons agree with returned context", async () => {
  const low = await fact(0.1),
    high = await fact(0.9),
    middle = await fact(0.8);
  const result = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", options());
  expect(result.candidates.map((c) => c.beliefVersionId)).toEqual([high.v, middle.v]);
  expect(result.abstained).toBe(false);
  const [trace] = await traces();
  expect(
    trace!.candidates
      .filter((c: { selected: boolean }) => c.selected)
      .map((c: { beliefVersionId: string }) => c.beliefVersionId),
  ).toEqual([high.v, middle.v]);
  expect(
    trace!.candidates.find((c: { beliefVersionId: string }) => c.beliefVersionId === low.v),
  ).toMatchObject({
    selected: false,
    reason: "token_budget",
    memoryBudget: { maxTokens: 2, tokenCount: 2, contextPosition: null },
  });
  expect(trace!.candidates[0].memoryBudget.contextPosition).toBe(1);
  expect(trace!.candidates[1].memoryBudget.contextPosition).toBe(2);
  expect(model.embedding).not.toHaveBeenCalled();
});
it("uses complete recorded_from microseconds, not valid_from, confidence or millisecond Date ordering", async () => {
  const older = await fact(0.5, "2026-01-01T00:00:00.123455Z", "needle", 0.99, "2030-01-01"),
    newer = await fact(0.5, "2026-01-01T00:00:00.123456Z", "needle", 0.1, "2010-01-01");
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ maxTokens: 1, countTokens: countEntries }),
  );
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([newer.v]);
  expect(
    (await traces())[0]!.candidates.find(
      (c: { beliefVersionId: string }) => c.beliefVersionId === older.v,
    ).reason,
  ).toBe("token_budget");
});
it("counts the exact numbered memory block later embedded by the actual chat prompt", async () => {
  await fact(0.8, undefined, { fact: "needle", nested: ["中文🧠", "line\nnext"] });
  await fact(0.9);
  const counter = vi.fn(countEntries);
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ maxTokens: 2, countTokens: counter }),
  );
  const prompt = buildChatSystemPrompt(r.candidates),
    block = counter.mock.calls.at(-1)![0];
  expect(prompt).toContain(`【检索到的相关记忆】\n${block}\n\n【回答规则】`);
  expect(block).toContain("中文🧠");
  expect(r.candidates).toHaveLength(2);
});
it("does not leapfrog an oversized higher-priority memory to admit a later small memory", async () => {
  const high = await fact(0.9, undefined, "needle too-big"),
    low = await fact(0.1);
  const counter = (s: string) => (s === "（无相关记忆）" ? 0 : s.includes("too-big") ? 100 : 1);
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ maxTokens: 2, countTokens: counter }),
  );
  expect(r.candidates).toEqual([]);
  expect(r.abstained).toBe(true);
  const [trace] = await traces();
  expect(trace!.abstained).toBe(true);
  expect(
    new Set(
      trace!.candidates
        .filter((c: { reason: string }) => c.reason === "token_budget")
        .map((c: { beliefVersionId: string }) => c.beliefVersionId),
    ),
  ).toEqual(new Set([high.v, low.v]));
});
it("applies salience priority within the fusion topK shortlist and preserves below_topk outside it", async () => {
  const low = await fact(0.1),
    highOutside = await fact(0.9);
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", { ...options(), topK: 1 });
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([low.v]);
  const other = (await traces())[0]!.candidates.find(
    (c: { beliefVersionId: string }) => c.beliefVersionId === highOutside.v,
  );
  expect(other.reason).toBe("below_topk");
  expect(other).not.toHaveProperty("memoryBudget");
});
it("counter failure hides raw errors, writes no partial trace and does not retry the retrieval", async () => {
  await fact(0.5);
  const counter = vi.fn(() => {
    throw Error("sk-private-tokenizer-error needle");
  });
  await expect(
    retrieve(t.db, TEST_MASTER_KEY, p, "needle", options({ maxTokens: 2, countTokens: counter })),
  ).rejects.toThrow(/^MEMORY_TOKEN_COUNT_FAILED$/);
  expect(counter).toHaveBeenCalledOnce();
  expect(await traces()).toEqual([]);
  expect(model.embedding).not.toHaveBeenCalled();
});
it("malformed persisted salience fails closed instead of silently estimating or substituting confidence", async () => {
  await fact(1.1);
  await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", options())).rejects.toThrow(
    /^INVALID_MEMORY_BUDGET_INPUT$/,
  );
  expect(await traces()).toEqual([]);
});
it("over-limit whole content fails rather than truncating text to make it fit", async () => {
  await fact(0.5, undefined, "needle " + "x".repeat(17000));
  await expect(retrieve(t.db, TEST_MASTER_KEY, p, "needle", options())).rejects.toThrow(
    /^INVALID_MEMORY_BUDGET_INPUT$/,
  );
  expect(await traces()).toEqual([]);
});
it("copies maxTokens and the callback before an SDK wait can mutate caller options", async () => {
  const a = await fact(0.8),
    b = await fact(0.9);
  const budget = { maxTokens: 1, countTokens: countEntries },
    replacement = vi.fn(() => 0),
    normal = model.embedding.getMockImplementation()!;
  model.embedding.mockImplementationOnce(async (args) => {
    budget.maxTokens = 100;
    budget.countTokens = replacement;
    return normal(args);
  });
  const r = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", {
    ...options(budget),
    flagsSnapshot: flags({ retrieval_vector: true }),
  });
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([b.v]);
  expect(replacement).not.toHaveBeenCalled();
  expect(
    (await traces())[0]!.candidates.find(
      (c: { beliefVersionId: string }) => c.beliefVersionId === a.v,
    ).memoryBudget.maxTokens,
  ).toBe(1);
});
it("reinforces only the final context, not a memory discarded by the budget", async () => {
  const low = await fact(0.2),
    high = await fact(0.8);
  await retrieve(t.db, TEST_MASTER_KEY, p, "needle", {
    ...options({ maxTokens: 1, countTokens: countEntries }),
    flagsSnapshot: flags({ read_time_reinforcement: true }),
  });
  expect(Number((await t.sql`select salience from beliefs where id=${low.b}`)[0]!.salience)).toBe(
    0.2,
  );
  expect(Number((await t.sql`select salience from beliefs where id=${high.b}`)[0]!.salience)).toBe(
    0.85,
  );
});
it("budget disabled leaves fusion order and DTO unchanged, with no budget trace metadata", async () => {
  const low = await fact(0.2),
    high = await fact(0.8);
  const off = await retrieve(t.db, TEST_MASTER_KEY, p, "needle", {
    ...options(),
    memoryBudget: undefined,
  });
  expect(off.candidates.map((c) => c.beliefVersionId)).toEqual([low.v, high.v]);
  expect(
    (await traces())
      .find((row) => row.id === off.traceId)!
      .candidates.every((c: object) => !("memoryBudget" in c)),
  ).toBe(true);
  expect(off.candidates[0]).not.toHaveProperty("salience");
});
it("new trace metadata never contains memory content or the tokenizer function", async () => {
  await fact(0.9, undefined, "needle sk-known-private-content");
  await fact(null);
  await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ maxTokens: 1, countTokens: countEntries }),
  );
  const encoded = JSON.stringify((await traces())[0]!.candidates);
  expect(encoded).not.toContain("sk-known-private-content");
  expect(encoded).not.toContain("countTokens");
  expect(encoded).not.toContain('"value"');
});
it.each([
  null,
  {},
  { maxTokens: -1, countTokens: countEntries },
  { maxTokens: 0.1, countTokens: countEntries },
  { maxTokens: 1000001, countTokens: countEntries },
  { maxTokens: 1, countTokens: "bad" },
  { maxTokens: 1, countTokens: countEntries, extra: "secret" },
])("invalid budget %# rejects before DB/model access", async (memoryBudget) => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error("DB trap");
    },
  });
  await expect(
    retrieve(db, TEST_MASTER_KEY, p, "needle", { fusion, memoryBudget }),
  ).rejects.toThrow(/^INVALID_RUNTIME_MEMORY_BUDGET$/);
  expect(reads).toBe(0);
});
it("budget without an explicit fusion request is rejected before DB/model access", async () => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error("DB trap");
    },
  });
  await expect(
    retrieve(db, TEST_MASTER_KEY, p, "needle", {
      memoryBudget: { maxTokens: 1, countTokens: countEntries },
    }),
  ).rejects.toThrow(/^INVALID_RUNTIME_MEMORY_BUDGET$/);
  expect(reads).toBe(0);
});
it("a budgeted read leaves entire belief/version rows unchanged when reinforcement is disabled", async () => {
  await fact(0.2);
  await fact(0.8);
  const before =
    await t.sql`select row_to_json(b) as belief,row_to_json(v) as version from beliefs b join belief_versions v on v.belief_id=b.id where b.project_id=${p} order by b.id,v.id`;
  await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ maxTokens: 1, countTokens: countEntries }),
  );
  expect(
    await t.sql`select row_to_json(b) as belief,row_to_json(v) as version from beliefs b join belief_versions v on v.belief_id=b.id where b.project_id=${p} order by b.id,v.id`,
  ).toEqual(before);
});
it("preserves NULL salience as lower priority than zero when hydrating SQL metadata", async () => {
  const missing = await fact(null),
    zero = await fact(0);
  const r = await retrieve(
    t.db,
    TEST_MASTER_KEY,
    p,
    "needle",
    options({ maxTokens: 1, countTokens: countEntries }),
  );
  expect(r.candidates.map((c) => c.beliefVersionId)).toEqual([zero.v]);
  expect(
    (await traces())[0]!.candidates.find(
      (c: { beliefVersionId: string }) => c.beliefVersionId === missing.v,
    ).reason,
  ).toBe("token_budget");
});
it("a later counter failure cannot publish an accepted partial context or trace", async () => {
  await fact(0.9);
  await fact(0.8);
  const countTokens = (s: string) => {
    if (s.includes("[2]")) throw Error("private counter output");
    return countEntries(s);
  };
  await expect(
    retrieve(t.db, TEST_MASTER_KEY, p, "needle", options({ maxTokens: 2, countTokens })),
  ).rejects.toThrow(/^MEMORY_TOKEN_COUNT_FAILED$/);
  expect(await traces()).toEqual([]);
});
