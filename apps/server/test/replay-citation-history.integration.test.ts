import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { conversations } from "../src/db/schema.js";
import { loadConversationMessages, messageViews, modelHistory } from "../src/chat/context.js";
import { ConversationDetailSchema } from "../src/contracts/conversation.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
const contract = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: { uuid: /^[0-9a-f-]{36}$/i, "date-time": /^\d{4}-\d\d-\d\dT/ },
});
ajv.addSchema({ components: contract.components }, "replay");
const validateDetail = ajv.compile({ $ref: "replay#/components/schemas/ConversationDetail" });
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let address: string;
beforeAll(async () => {
  t = await setupTestDb({ isolated: true });
  app = buildApp({
    authToken: "offline-replay-test-token-000000000000",
    db: t.db,
    masterKey: TEST_MASTER_KEY,
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
}, 60000);
afterAll(async () => {
  await app?.close();
  await t?.close();
});
async function fixture(project?: string, attribute = "database") {
  const p = project ?? uuidv7(),
    b = uuidv7(),
    v = uuidv7(),
    o = uuidv7(),
    e = uuidv7(),
    c = uuidv7(),
    a = uuidv7();
  if (!project) await t.sql`insert into projects(id,name) values(${p},'citation fixture')`;
  await t.sql`insert into conversations(id,project_id) values(${c},${p})`;
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values(${e},${c},'user','offline original Evidence','2025-01-01Z')`;
  await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,evidence_id,recorded_at) values(${o},${p},'fact','app',${attribute},'"SQLite alternate sentinel"','UPDATE','USER_EXPLICIT',60,${e},'2025-01-02Z')`;
  await t.sql`insert into beliefs(id,project_id,subject,attribute) values(${b},${p},'app',${attribute})`;
  await t.sql`insert into belief_versions(id,belief_id,value,valid_from,recorded_from) values(${v},${b},'"PostgreSQL anchor sentinel"','2025-01-01Z','2025-01-01Z')`;
  await t.sql`update beliefs set current_version_id=${v} where id=${b}`;
  const ref = {
    kind: "observation_replay",
    belief_id: b,
    anchor_version_id: v,
    observation_id: o,
    evidence_id: e,
  };
  await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time,memories) values(${a},${c},'assistant','saved answer','2025-01-03Z',${JSON.stringify([ref, v])}::jsonb)`;
  return { p, b, v, o, e, c, a, ref };
}
async function views(f: Awaited<ReturnType<typeof fixture>>, activeOnly = false) {
  const [conv] = await t.db.select().from(conversations).where(eq(conversations.id, f.c));
  return messageViews(t.db, f.p, await loadConversationMessages(t.db, conv!), activeOnly);
}
it("real HTTP history resolves mixed citations from actual Observation and original version", async () => {
  const f = await fixture();
  const response = await fetch(`${address}/projects/${f.p}/conversations/${f.c}`, {
    headers: { authorization: "Bearer offline-replay-test-token-000000000000" },
  });
  expect(response.status).toBe(200);
  const json = await response.json();
  expect(validateDetail(json), JSON.stringify(validateDetail.errors)).toBe(true);
  const body = ConversationDetailSchema.parse(json);
  expect(body.messages[1]?.memories).toEqual([
    {
      belief_id: f.b,
      belief_version_id: null,
      subject: "app",
      attribute: "database",
      value: "SQLite alternate sentinel",
      provenance: {
        kind: "observation_replay",
        anchor_version_id: f.v,
        observation_id: f.o,
        evidence_id: f.e,
      },
    },
    {
      belief_id: f.b,
      belief_version_id: f.v,
      subject: "app",
      attribute: "database",
      value: "PostgreSQL anchor sentinel",
    },
  ]);
  const [stored] = await t.sql`select memories from messages where id=${f.a}`;
  expect(stored?.memories).toEqual([f.ref, f.v]);
  expect(JSON.stringify(stored?.memories)).not.toMatch(/SQLite|PostgreSQL|subject|attribute|value/);
});
it.each([
  "foreign_observation",
  "foreign_evidence",
  "foreign_anchor",
  "wrong_belief",
  "wrong_anchor",
  "wrong_group",
  "wrong_evidence",
  "extra_content",
  "missing_source",
])("filters poisoned replay reference %s without losing a valid legacy citation", async (mode) => {
  const f = await fixture();
  const foreign = await fixture();
  const same = await fixture(f.p, "backend");
  let ref: Record<string, unknown> = { ...f.ref };
  if (mode === "foreign_observation")
    ref = { ...ref, observation_id: foreign.o, evidence_id: foreign.e };
  if (mode === "foreign_evidence") {
    await t.sql`update observations set evidence_id=${foreign.e} where id=${f.o}`;
    ref.evidence_id = foreign.e;
  }
  if (mode === "foreign_anchor") ref.anchor_version_id = foreign.v;
  if (mode === "wrong_anchor") ref.anchor_version_id = same.v;
  if (mode === "wrong_belief") ref.belief_id = same.b;
  if (mode === "wrong_group") ref = { ...ref, observation_id: same.o, evidence_id: same.e };
  if (mode === "wrong_evidence") ref.evidence_id = same.e;
  if (mode === "extra_content") ref.value = "forged-content-sentinel";
  if (mode === "missing_source") ref.observation_id = uuidv7();
  await t.sql`update messages set memories=${JSON.stringify([ref, f.v])}::jsonb where id=${f.a}`;
  const result = (await views(f))[1]?.memories;
  expect(result).toHaveLength(1);
  expect(result?.[0]).toMatchObject({
    belief_version_id: f.v,
    value: "PostgreSQL anchor sentinel",
  });
  expect(JSON.stringify(result)).not.toMatch(/SQLite|forged-content/);
});
it("a selected JSON null remains a fact and a historical anchor need not remain current", async () => {
  const f = await fixture();
  await t.sql`update observations set value='null'::jsonb where id=${f.o}`;
  await t.sql`update beliefs set current_version_id=null where id=${f.b}`;
  const result = (await views(f))[1]?.memories;
  expect(result?.[0]).toMatchObject({ belief_version_id: null, value: null });
});
it.each(["deleted", "retracted"])(
  "retains %s history for display but excludes it from model history",
  async (status) => {
    const f = await fixture();
    await t.sql`update beliefs set status=${status} where id=${f.b}`;
    expect((await views(f))[1]?.memories).toHaveLength(2);
    expect((await views(f, true))[1]?.memories).toEqual([]);
    const [conv] = await t.db.select().from(conversations).where(eq(conversations.id, f.c));
    const history = await modelHistory(t.db, f.p, await loadConversationMessages(t.db, conv!));
    expect(JSON.stringify(history)).not.toMatch(/alternate sentinel|anchor sentinel/);
  },
);
it("inherited history keeps actual provenance without copying or replaying facts", async () => {
  const f = await fixture();
  const fork = uuidv7();
  await t.sql`insert into conversations(id,project_id,meta) values(${fork},${f.p},${JSON.stringify({ resume: { version: 1, from: f.c, message_ids: [f.e, f.a] } })}::jsonb)`;
  const result = await views({ ...f, c: fork });
  expect(result[1]?.memories?.[0]).toMatchObject({
    belief_version_id: null,
    provenance: { observation_id: f.o, evidence_id: f.e },
  });
  const history = await modelHistory(
    t.db,
    f.p,
    await loadConversationMessages(
      t.db,
      (await t.db.select().from(conversations).where(eq(conversations.id, fork)))[0]!,
    ),
  );
  expect(JSON.stringify(history)).toContain("SQLite alternate sentinel");
  const [count] = await t.sql`select count(*) as n from messages where conversation_id=${fork}`;
  expect(count?.n).toBe("0");
});
it("fails closed on more than 32 replay refs per message while retaining legacy history", async () => {
  const f = await fixture();
  await t.sql`update messages set memories=${JSON.stringify([...Array(33).fill(f.ref), f.v])}::jsonb where id=${f.a}`;
  expect((await views(f))[1]?.memories).toHaveLength(1);
});

it("resolves a hundred messages with two batched lookups and preserves each reference order", async () => {
  const f = await fixture();
  const [conv] = await t.db.select().from(conversations).where(eq(conversations.id, f.c));
  const saved = await loadConversationMessages(t.db, conv!);
  const msg = saved.find((m) => m.id === f.a)!;
  const select = vi.spyOn(t.db, "select");
  try {
    const result = await messageViews(
      t.db,
      f.p,
      Array.from({ length: 100 }, () => ({ ...msg, id: uuidv7() })),
    );
    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(100);
    for (const row of result)
      expect(row.memories?.map((m) => m.belief_version_id)).toEqual([null, f.v]);
  } finally {
    select.mockRestore();
  }
});
