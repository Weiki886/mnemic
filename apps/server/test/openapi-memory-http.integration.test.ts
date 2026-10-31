import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { readFeatureFlags } from "../src/flags/repository.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import type { OpenApiDocument } from "../scripts/openapi.js";
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "date-time": /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/,
  },
});
ajv.addSchema({ components: doc.components }, "memory");
const token = "memory-contract-offline-token-000000";
const headers = { authorization: `Bearer ${token}` };
const basePath = "/projects/{projectId}/beliefs",
  detailPath = basePath + "/{id}";
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  base: string,
  saved: Awaited<ReturnType<typeof readFeatureFlags>>;
const projectId = uuidv7(),
  otherProjectId = uuidv7(),
  beliefId = uuidv7(),
  versionId = uuidv7();
const models = vi.fn(() => {
  throw Error("contract tests must never invoke models");
});
function schema(path: string, method: "get" | "post", status: number) {
  const op = doc.paths[path]?.[method];
  expect(op, `missing operation ${method} ${path}`).toBeTruthy();
  const response = op!.responses[String(status)] as {
    content: Record<string, { schema: unknown }>;
  };
  expect(response, `undocumented status ${status}`).toBeTruthy();
  return Object.values(response.content)[0]!.schema;
}
function validate(shape: unknown, value: unknown) {
  const rewritten = JSON.parse(
    JSON.stringify(shape).replaceAll('"#/components/', '"memory#/components/'),
  );
  const validator = ajv.compile(rewritten);
  expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
}
async function request(
  path: string,
  method: "get" | "post",
  status: number,
  options: {
    project?: string;
    id?: string;
    query?: string;
    body?: unknown;
    raw?: string;
    auth?: boolean;
    media?: string;
  } = {},
) {
  const url =
    path
      .replace("{projectId}", options.project ?? projectId)
      .replace("{id}", options.id ?? beliefId) + (options.query ?? "");
  const r = await fetch(base + url, {
    method: method.toUpperCase(),
    headers: {
      ...(options.auth === false ? {} : headers),
      ...(options.body !== undefined || options.raw !== undefined
        ? { "content-type": options.media ?? "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : options.raw !== undefined
        ? { body: options.raw }
        : {}),
  });
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("x-request-id")).toBeTruthy();
  expect(r.headers.get("content-type")).toContain(
    status === 200 ? "application/json" : "application/problem+json",
  );
  validate(schema(path, method, status), body);
  return body;
}
beforeAll(async () => {
  t = await setupTestDb();
  saved = await readFeatureFlags(t.db);
  await t.sql`update feature_flags set flags=${JSON.stringify(DEFAULT_FEATURE_FLAGS)}::jsonb where scope='server'`;
  await t.sql`insert into projects (id,name) values (${projectId},'openapi-memory'),(${otherProjectId},'openapi-memory-other')`;
  await t.sql`insert into beliefs (id,project_id,subject,attribute,confidence,salience,importance) values (${beliefId},${projectId},'project','database',0.9,0.5,0.8)`;
  await t.sql`insert into belief_versions (id,belief_id,value,valid_from,recorded_from,confidence) values (${versionId},${beliefId},${JSON.stringify({ engine: "PostgreSQL", nested: [null, 1] })},now(),now(),null)`;
  await t.sql`update beliefs set current_version_id=${versionId} where id=${beliefId}`;
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    providerFactory: { languageModel: models, embeddingModel: models },
    logStream: { write: () => {} },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  await app?.close();
  if (t) {
    await t.sql`update feature_flags set flags=${JSON.stringify(saved.flags)}::jsonb,revision=${saved.revision} where scope='server'`;
    await t.close();
  }
  expect(models).not.toHaveBeenCalled();
});
it("artifact correction example runs through all six operations over TCP with numeric scores and provenance", async () => {
  const list = await request(basePath, "get", 200, { query: "?limit=1&offset=0&unknown=ignored" });
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: beliefId, confidence: 0.9, type: null });
  const before = await request(detailPath, "get", 200);
  expect(before.versions[0]).toMatchObject({ source: null, confidence: null });
  expect(before.current_value).toEqual({ engine: "PostgreSQL", nested: [null, 1] });
  const op = doc.paths[detailPath + "/correct"]!.post!;
  const rb = op.requestBody as { content: Record<string, { schema: unknown; example: unknown }> };
  const example = rb.content["application/json"]!;
  validate(example.schema, example.example);
  expect(
    await request(detailPath + "/correct", "post", 200, { body: example.example }),
  ).toMatchObject({ beliefId, route: "conflict", relation: "supersede" });
  const after = await request(detailPath, "get", 200);
  expect(after.current_value).toBe("SQLite");
  expect(after.versions).toHaveLength(2);
  expect(after.versions[1].source).toMatchObject({
    message_id: expect.any(String),
    conversation_id: expect.any(String),
  });
  const history = await request(detailPath + "/resolutions", "get", 200);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    beliefId,
    relation: "supersede",
    confidenceAfter: 1,
    flagsSnapshot: { flags: DEFAULT_FEATURE_FLAGS },
  });
  expect(await request(detailPath + "/delete", "post", 200)).toEqual({
    id: beliefId,
    status: "deleted",
  });
  await request(detailPath + "/delete", "post", 409);
  await request(detailPath + "/correct", "post", 409, { body: example.example });
  expect((await t.sql`select status from beliefs where id=${beliefId}`)[0]!.status).toBe("deleted");
  expect(await request(detailPath + "/restore", "post", 200)).toEqual({
    id: beliefId,
    status: "active",
  });
  await request(detailPath + "/restore", "post", 409);
  const audits =
    await t.sql`select action from audit_log where target=${beliefId} and action in ('belief.delete','belief.restore') order by ts`;
  expect(audits.map((r) => r.action)).toEqual(["belief.delete", "belief.restore"]);
});
it.each([
  ["", "get"],
  ["/correct", "post"],
  ["/delete", "post"],
  ["/restore", "post"],
  ["/resolutions", "get"],
] as const)("cross-project %s returns documented 404 without mutation", async (suffix, method) => {
  await request(detailPath + suffix, method, 404, {
    project: otherProjectId,
    ...(suffix === "/correct" ? { body: { value: "wrong" } } : {}),
  });
  expect((await t.sql`select status from beliefs where id=${beliefId}`)[0]!.status).toBe("active");
});
it.each([
  [basePath, "get", { project: "bad" }],
  [detailPath, "get", { id: "bad" }],
  [basePath, "get", { query: "?limit=1001" }],
  [basePath, "get", { query: "?status=expired" }],
  [detailPath + "/correct", "post", { body: { value: "" } }],
] as const)("invalid input %s %s yields structured 400", async (path, method, options) => {
  const r = await request(path, method, 400, options);
  expect(r.errors.length).toBeGreaterThan(0);
});
it("authentication rejects malformed correction before parsing JSON", async () => {
  await request(detailPath + "/correct", "post", 401, { raw: "{broken", auth: false });
});
it("empty unknown project list is 200; literal wildcard does not match every belief", async () => {
  expect(await request(basePath, "get", 200, { project: uuidv7() })).toEqual([]);
  expect(await request(basePath, "get", 200, { query: "?q=%25" })).toEqual([]);
});
it.each([null, true, 42, ["value", null]])(
  "JSONB value %j remains an explicit field rather than an omitted one",
  async (value) => {
    const id = uuidv7(),
      vid = uuidv7();
    await t.sql`insert into beliefs (id,project_id,subject,attribute) values (${id},${projectId},${"json-" + id},'value')`;
    await t.sql`insert into belief_versions (id,belief_id,value,valid_from,recorded_from) values (${vid},${id},${JSON.stringify(value)},now(),now())`;
    await t.sql`update beliefs set current_version_id=${vid} where id=${id}`;
    const body = await request(detailPath, "get", 200, { id });
    expect(body).toHaveProperty("current_value", value);
    expect(body.versions[0]).toHaveProperty("value", value);
  },
);
it.each([
  [415, "text/xml", "<value/>"],
  [413, "application/json", JSON.stringify({ value: "a".repeat(1048576) })],
] as const)(
  "parser %s response obeys the documented problem contract",
  async (status, media, raw) => {
    await request(detailPath + "/correct", "post", status, { media, raw });
  },
);
