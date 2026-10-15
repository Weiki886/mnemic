import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { createApiClient } from "@mnemic/shared";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { beliefs } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

describe("numeric HTTP 响应契约（#68）", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let projectId: string;
  let beliefId: string;
  let nullBeliefId: string;
  const value = { confidence: "0.900", port: 5432 };
  const metadata = { weight: "0.500" };

  beforeAll(async () => {
    t = await setupTestDb();
    projectId = uuidv7();
    beliefId = uuidv7();
    nullBeliefId = uuidv7();
    const cid = uuidv7();
    const mid = uuidv7();
    const oid = uuidv7();
    await t.sql`insert into projects (id, name) values (${projectId}, 'numeric-contract')`;
    await t.sql`insert into conversations (id, project_id) values (${cid}, ${projectId})`;
    await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time)
      values (${mid}, ${cid}, 'user', '原始事实', now())`;
    await t.sql`insert into observations
      (id, project_id, type, subject, attribute, value, assertion_intent, source_type, authority, evidence_id)
      values (${oid}, ${projectId}, 'fact', 'numeric-fact', 'db', ${JSON.stringify(value)}, 'ASSERT', 'USER_EXPLICIT', 60, ${mid})`;
    await t.sql`insert into beliefs (id, project_id, subject, attribute, confidence, salience, importance)
      values (${beliefId}, ${projectId}, 'numeric-fact', 'db', 0.875, 0, 1),
        (${nullBeliefId}, ${projectId}, 'null-fact', 'db', null, null, null)`;
    for (const [index, confidence] of ["0.125", "0.000", "1.000", null].entries()) {
      const vid = uuidv7();
      await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from, confidence)
        values (${vid}, ${beliefId}, ${JSON.stringify(value)}, '2026-09-01', ${new Date(Date.UTC(2026, 8, index + 1)).toISOString()}, ${confidence})`;
      if (index === 3)
        await t.sql`update beliefs set current_version_id = ${vid} where id = ${beliefId}`;
    }
    await t.sql`insert into resolution_traces
      (id, project_id, belief_id, observation_id, confidence_before, confidence_after, policies, model_snapshot, resolver_version, created_at)
      values (${uuidv7()}, ${projectId}, ${beliefId}, ${oid}, 0.125, 0.875, ${JSON.stringify(metadata)}, ${JSON.stringify(metadata)}, 'test', '2026-09-01'),
        (${uuidv7()}, ${projectId}, ${beliefId}, ${oid}, 0, 1, '{}', null, 'test', '2026-09-02'),
        (${uuidv7()}, ${projectId}, ${beliefId}, ${oid}, null, null, '{}', null, 'test', '2026-09-03')`;
    app = buildApp({ db: t.db, masterKey: TEST_MASTER_KEY });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  const url = (id: string) => `/projects/${projectId}/beliefs/${id}`;

  it("列表的评分为 number，保留小数、0 和 1", async () => {
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/beliefs` });
    expect(res.statusCode).toBe(200);
    const row = res.json().find((item: { id: string }) => item.id === beliefId);
    expect(row).toMatchObject({
      confidence: 0.875,
      salience: 0,
      importance: 1,
      current_value: value,
    });
    for (const field of ["confidence", "salience", "importance"])
      expect(typeof row[field]).toBe("number");
  });

  it("详情和每个版本评分为 number|null，不改正文里的数字字符串", async () => {
    const res = await app.inject({ method: "GET", url: url(beliefId) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      confidence: 0.875,
      salience: 0,
      importance: 1,
      current_value: value,
    });
    expect(body.versions.map((version: { confidence: unknown }) => version.confidence)).toEqual([
      0.125,
      0,
      1,
      null,
    ]);
    for (const version of body.versions) expect(version.value).toEqual(value);
  });

  it("列表和详情保留数据库 NULL，不转换成 0", async () => {
    const list = await app.inject({ method: "GET", url: `/projects/${projectId}/beliefs` });
    const row = list.json().find((item: { id: string }) => item.id === nullBeliefId);
    expect(row).toMatchObject({ confidence: null, salience: null, importance: null });
    const detail = await app.inject({ method: "GET", url: url(nullBeliefId) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      confidence: null,
      salience: null,
      importance: null,
      versions: [],
    });
  });

  it("消解历史前后评分为 number|null，其他 JSON 数据保持原样", async () => {
    const res = await app.inject({ method: "GET", url: `${url(beliefId)}/resolutions` });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(
      rows.map((row: { confidenceBefore: unknown; confidenceAfter: unknown }) => [
        row.confidenceBefore,
        row.confidenceAfter,
      ]),
    ).toEqual([
      [0.125, 0.875],
      [0, 1],
      [null, null],
    ]);
    expect(rows[0]).toMatchObject({ policies: metadata, modelSnapshot: metadata });
  });

  it("shared client 消费真实 PG HTTP 响应，数字可直接调用 toFixed", async () => {
    const api = createApiClient({
      baseUrl: "http://mnemic.test",
      fetch: async (input) => {
        const response = await app.inject({ method: "GET", url: new URL(String(input)).pathname });
        return new Response(response.payload, {
          status: response.statusCode,
          headers: { "content-type": String(response.headers["content-type"]) },
        });
      },
    });
    const list = await api.listBeliefs(projectId);
    const row = list.find((item) => item.id === beliefId)!;
    expect(row.confidence).toBe(0.875);
    expect(row.confidence!.toFixed(3)).toBe("0.875");
    const detail = await api.getBelief(projectId, beliefId);
    expect(detail.versions[0]!.confidence!.toFixed(3)).toBe("0.125");
    const traces = await api.listResolutions(projectId, beliefId);
    expect(traces[0]!.confidenceAfter!.toFixed(3)).toBe("0.875");
    expect(traces[2]!.confidenceBefore).toBeNull();
    const absent = await api.getBelief(projectId, nullBeliefId);
    expect(absent.confidence).toBeNull();
  });

  it("读取 API 不改变数据库 numeric 字符串和值", async () => {
    const before =
      await t.sql`select confidence::text, salience::text, importance::text from beliefs where id = ${beliefId}`;
    expect(before[0]).toEqual({ confidence: "0.875", salience: "0.000", importance: "1.000" });
    const [raw] = await t.db
      .select({ confidence: beliefs.confidence })
      .from(beliefs)
      .where(eq(beliefs.id, beliefId));
    expect(raw!.confidence).toBe("0.875");
    await app.inject({ method: "GET", url: url(beliefId) });
    const after =
      await t.sql`select confidence::text, salience::text, importance::text from beliefs where id = ${beliefId}`;
    expect(after).toEqual(before);
  });
});
