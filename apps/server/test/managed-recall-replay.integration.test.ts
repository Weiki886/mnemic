import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { createApiClient } from "@mnemic/shared";
import { RecallResultSchema } from "@mnemic/shared/memory";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
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

it.each(["enabled", "off", "retract", "corrupt", "strict", "unbound"])(
  "real HTTP managed recall %s preserves provenance and read-only behavior",
  async (mode) => {
    const f = await fixture();
    const flags = {
      ...DEFAULT_FEATURE_FLAGS,
      retrieval_vector: false,
      authority_resolution: false,
      read_time_resolution: mode !== "off",
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
      recallBinding: binding,
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
        const raw = await api.recallBeliefs(f.p, "needle");
        expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
        const r = RecallResultSchema.parse(raw);
        expect(r.candidates[0]?.value).toBe("needle PostgreSQL");
        expect(r.abstained).toBe(false);
        expect(r.trace.flags_snapshot?.flags.read_time_reinforcement).toBe(false);
        if (mode === "off") expect(r).not.toHaveProperty("read_time_context");
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
