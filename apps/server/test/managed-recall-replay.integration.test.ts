import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBudgetTokenizerFixture } from "./fixtures/budget-tokenizer.js";
import { Ajv } from "ajv";
import { createApiClient } from "@mnemic/shared";
import { RecallResultSchema } from "@mnemic/shared/memory";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { resolveStartupRetrievalBindings } from "../src/retrieval/startup-binding.js";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
}, 60000);
afterAll(async () => {
  await t?.close();
});
const token = "offline-recall-replay-token-00000000";
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, formats: { uuid: /^[0-9a-f-]{36}$/i } });
ajv.addSchema({ components: doc.components }, "recall");
const validate = ajv.compile({ $ref: "recall#/components/schemas/RecallResult" });
async function fixture(projectId?: string, attribute = "database") {
  const p = projectId ?? uuidv7(),
    b = uuidv7(),
    v = uuidv7(),
    old = uuidv7(),
    next = uuidv7(),
    c = uuidv7(),
    e1 = uuidv7(),
    e2 = uuidv7();
  if (!projectId) await t.sql`insert into projects(id,name) values(${p},'runtime replay')`;
  await t.sql`insert into conversations(id,project_id) values(${c},${p})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${e1},${c},'user','offline',now()),(${e2},${c},'user','offline',now())`;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,recorded_at,evidence_id)
 values(${old},${p},'fact','app',${attribute},'"needle PostgreSQL"','ASSERT','USER_CORRECTION',70,'2025-01-01Z',${e1}),
 (${next},${p},'fact','app',${attribute},'"SQLite private-value-sentinel"','UPDATE','PROJECT_FILE',50,'2025-02-01Z',${e2})`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute,salience) values(${b},${p},'app',${attribute},'0.400')`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from,source_observation_id) values(${v},${b},'"needle PostgreSQL"','2025-01-01Z','2025-01-01Z',${old})`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  return { p, b, v, old, next, e1, e2 };
}
async function business(p: string) {
  const [r] = await t.sql`select
 (select jsonb_agg(to_jsonb(b) order by id) from beliefs b where project_id=${p}) as beliefs,
 (select jsonb_agg(to_jsonb(v) order by id) from belief_versions v where belief_id in(select id from beliefs where project_id=${p})) as versions,
 (select jsonb_agg(to_jsonb(o) order by id) from observations o where project_id=${p}) as observations`;
  return JSON.stringify(r);
}

const modes = [
  "enabled",
  "off",
  "retract",
  "corrupt",
  "strict",
  "unbound",
  "uppercase",
  "startup-on",
  "startup-off",
];

it.each(modes)(
  "real HTTP managed recall %s preserves provenance and read-only behavior",
  async (mode) => {
    const f = await fixture();
    const flagOn = mode !== "off" && mode !== "startup-off";
    const flags = {
      ...DEFAULT_FEATURE_FLAGS,
      retrieval_vector: false,
      authority_resolution: false,
      read_time_resolution: flagOn,
      read_time_reinforcement: true,
    };
    await t.sql`update feature_flags set flags=${JSON.stringify(flags)}::jsonb`;
    if (mode === "retract")
      await t.sql`update observations set assertion_intent='RETRACT',source_type='USER_EXPLICIT' where id=${f.next}`;
    if (mode === "corrupt") {
      const foreign = await fixture();
      await t.sql`update observations set evidence_id=${foreign.e2} where id=${f.next}`;
    }
    const before = await business(f.p);
    const model = vi.fn(() => {
      throw Error("no model allowed");
    });
    const binding = {
      fusion: { mode: "rrf", threshold: 0.001 },
      rerankerProvider: {},
      ...(mode !== "unbound" ? { readTimeResolution: true } : {}),
    };
    const app = buildApp({
      authToken: token,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      modelDailyCallLimit: 100,
      providerFactory: { languageModel: model, embeddingModel: model },
      ...(mode === "startup-on" || mode === "startup-off"
        ? resolveStartupRetrievalBindings(
            JSON.stringify({
              fusion: binding.fusion,
              rerankerProvider: binding.rerankerProvider,
              recallReadTimeResolution: true,
            }),
            { databaseConfigured: true, masterKey: TEST_MASTER_KEY },
          )
        : { recallBinding: binding }),
    });
    binding.fusion.threshold = 1;
    if (binding.readTimeResolution !== undefined) binding.readTimeResolution = false;
    try {
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const api = createApiClient({ baseUrl: base, token });
      if (mode === "strict") {
        const unauth = await fetch(`${base}/projects/${f.p}/recall`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{broken",
        });
        expect(unauth.status).toBe(401);
        const bad = await fetch(`${base}/projects/${f.p}/recall`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ query: "needle", readTimeResolution: true }),
        });
        expect(bad.status).toBe(400);
      } else if (mode === "corrupt" || mode === "unbound") {
        await expect(api.recallBeliefs(f.p, "needle")).rejects.toMatchObject({ status: 500 });
      } else {
        const raw = await api.recallBeliefs(
          mode === "uppercase" ? f.p.toUpperCase() : f.p,
          "needle",
        );
        expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
        const r = RecallResultSchema.parse(raw);
        expect(r.candidates[0]?.value).toBe("needle PostgreSQL");
        expect(r.abstained).toBe(false);
        expect(r.trace.flags_snapshot?.flags.read_time_reinforcement).toBe(false);
        if (!flagOn) expect(r).not.toHaveProperty("read_time_context");
        else if (mode === "retract")
          expect(r.read_time_context).toEqual({ abstained: true, memories: [] });
        else
          expect(r.read_time_context).toMatchObject({
            abstained: false,
            memories: [
              {
                belief_id: f.b,
                belief_version_id: null,
                value: "SQLite private-value-sentinel",
                provenance: { observation_id: f.next, evidence_id: f.e2, anchor_version_id: f.v },
              },
            ],
          });
        expect(JSON.stringify(r.trace)).not.toMatch(/SQLite|PostgreSQL|private-value-sentinel/);
      }
      expect(model).not.toHaveBeenCalled();
      expect(await business(f.p)).toBe(before);
    } finally {
      await app.close();
    }
  },
);

it.each(["partial", "empty", "replay-empty"] as const)(
  "trusted Recall %s returns budgeted memories and a valid score-only trace",
  async (mode) => {
    const replay = mode === "replay-empty";
    const first = await fixture();
    const second = await fixture(first.p, "secondary");
    await t.sql`update beliefs set salience='0.800' where id=${first.b}`;
    const flags = {
      ...DEFAULT_FEATURE_FLAGS,
      retrieval_vector: false,
      authority_resolution: false,
      read_time_resolution: replay,
      read_time_reinforcement: true,
    };
    await t.sql`update feature_flags set flags=${JSON.stringify(flags)}::jsonb`;
    const before = await business(first.p);
    const model = vi.fn(() => {
      throw Error("no model allowed");
    });
    const limit = mode === "partial" ? '[1] app / database = "needle PostgreSQL"'.length : 12;
    const countTokens = vi.fn((text: string) => text.length);
    const memoryBudget = { maxTokens: limit, countTokens };
    const app = buildApp({
      authToken: token,
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      modelDailyCallLimit: 100,
      providerFactory: { languageModel: model, embeddingModel: model },
      recallBinding: {
        fusion: { mode: "rrf", threshold: 0.001 },
        rerankerProvider: {},
        ...(replay ? { readTimeResolution: true } : {}),
        memoryBudget,
      },
    });
    memoryBudget.maxTokens = 0;
    const mutatedCounter = vi.fn((_text: string) => 0);
    memoryBudget.countTokens = mutatedCounter;

    try {
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const api = createApiClient({ baseUrl: base, token });
      const result = await api.recallBeliefs(first.p, "needle");
      expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
      expect(result.trace.flags_snapshot?.flags.read_time_reinforcement).toBe(false);
      if (replay) {
        expect(result.abstained).toBe(false);
        expect(result.candidates).toHaveLength(2);
        expect(result.read_time_context).toEqual({ memories: [], abstained: true });
        expect(result.trace.candidates.every((c) => c.selected && c.reason === "top_k")).toBe(true);
        expect(countTokens).toHaveBeenCalledWith(
          '[1] app / database = "SQLite private-value-sentinel"',
        );
      } else {
        expect(result).not.toHaveProperty("read_time_context");
        expect(result.abstained).toBe(mode === "empty");
        expect(result.candidates.map((c) => c.beliefVersionId)).toEqual(
          mode === "partial" ? [first.v] : [],
        );
        expect(result.trace.candidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              beliefVersionId: second.v,
              selected: false,
              reason: "token_budget",
            }),
          ]),
        );
      }
      expect(result.trace.candidates.every((c) => !("memoryBudget" in c) && !("value" in c))).toBe(
        true,
      );
      const [stored] =
        await t.sql`select candidates from retrieval_traces where id=${result.trace.id}`;
      const secondTrace = stored?.candidates.find(
        (c: { beliefVersionId: string }) => c.beliefVersionId === second.v,
      );
      if (replay) {
        expect(secondTrace.readTimeResolution).toMatchObject({
          status: "budget_discarded",
          reason: "token_budget",
          memoryBudget: { maxTokens: limit, contextPosition: null },
        });
      } else {
        expect(secondTrace).toMatchObject({
          reason: "token_budget",
          memoryBudget: { maxTokens: limit, contextPosition: null },
        });
      }
      expect(mutatedCounter).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
      expect(await business(first.p)).toBe(before);
    } finally {
      await app.close();
    }
  },
);

it.each([false, true])(
  "startup Recall applies the local tokenizer budget over HTTP (replay %s)",
  async (replay) => {
    const f = await fixture();
    await t.sql`update feature_flags set flags=${JSON.stringify({
      ...DEFAULT_FEATURE_FLAGS,
      retrieval_vector: false,
      authority_resolution: false,
      read_time_resolution: replay,
      read_time_reinforcement: true,
    })}::jsonb`;
    const before = await business(f.p);
    const model = vi.fn(() => {
      throw Error("no model allowed");
    });
    const dir = mkdtempSync(join(tmpdir(), "mnemic-startup-recall-"));
    try {
      const paths = writeBudgetTokenizerFixture(dir);
      const bindings = resolveStartupRetrievalBindings(
        JSON.stringify({
          fusion: { mode: "rrf", threshold: 0.001 },
          rerankerProvider: {},
          ...(replay ? { recallReadTimeResolution: true } : {}),
          recallMemoryBudget: { maxTokens: 1, ...paths },
        }),
        { databaseConfigured: true, masterKey: TEST_MASTER_KEY },
      );
      const app = buildApp({
        ...bindings,
        authToken: token,
        db: t.db,
        masterKey: TEST_MASTER_KEY,
        modelDailyCallLimit: 100,
        providerFactory: { languageModel: model, embeddingModel: model },
      });
      try {
        const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
        const result = await createApiClient({ baseUrl, token }).recallBeliefs(f.p, "needle");
        expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
        expect(result.trace.flags_snapshot?.flags.read_time_reinforcement).toBe(false);
        expect(result.trace.candidates).toMatchObject([
          { beliefVersionId: f.v, selected: replay, reason: replay ? "top_k" : "token_budget" },
        ]);
        expect(result.abstained).toBe(!replay);
        if (replay) {
          expect(result.candidates[0]?.value).toBe("needle PostgreSQL");
          expect(result.read_time_context).toEqual({ abstained: true, memories: [] });
        } else {
          expect(result.candidates).toEqual([]);
          expect(result).not.toHaveProperty("read_time_context");
        }
        const [stored] =
          await t.sql`select candidates from retrieval_traces where id=${result.trace.id}`;
        const decision = replay ? stored?.candidates[0].readTimeResolution : stored?.candidates[0];
        expect(decision).toMatchObject({
          reason: "token_budget",
          memoryBudget: { maxTokens: 1, tokenCount: 1, contextPosition: null },
        });
        expect(model).not.toHaveBeenCalled();
        expect(await business(f.p)).toBe(before);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
