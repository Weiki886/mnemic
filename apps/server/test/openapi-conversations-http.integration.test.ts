import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app.js";
import { registerChatRoutes } from "../src/chat/routes.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import type {
  ChatConversation,
  ChatCommit,
  ChatResume,
  ConversationDetail,
  ConversationListItem,
  ProblemDetails,
} from "@mnemic/shared";
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
ajv.addSchema({ components: doc.components }, "conversation");
const listPath = "/projects/{projectId}/conversations",
  detailPath = listPath + "/{id}",
  resumePath = detailPath + "/resume",
  commitPath = "/v1/conversations/{id}/commit";
const projectId = uuidv7(),
  foreignProject = uuidv7(),
  sourceId = uuidv7(),
  userId = uuidv7(),
  foreignConv = uuidv7();
const token = "conversation-contract-offline-000000",
  headers = { authorization: `Bearer ${token}` };
const models = vi.fn(() => {
  throw Error("lifecycle contracts must not invoke models");
});
let t: TestDb, app: ReturnType<typeof buildApp>, base: string;
function validate(schema: unknown, body: unknown) {
  const rewritten = JSON.parse(
    JSON.stringify(schema).replaceAll('"#/components/', '"conversation#/components/'),
  );
  const v = ajv.compile(rewritten);
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
async function request<T = unknown>(
  path: string,
  method: "get" | "post",
  status: number,
  opts: {
    id?: string;
    project?: string;
    query?: string;
    body?: unknown;
    raw?: string;
    media?: string;
    auth?: boolean;
  } = {},
) {
  const r = await fetch(
    base +
      path.replace("{projectId}", opts.project ?? projectId).replace("{id}", opts.id ?? sourceId) +
      (opts.query ?? ""),
    {
      method: method.toUpperCase(),
      headers: {
        ...(opts.auth === false ? {} : headers),
        ...(opts.body !== undefined || opts.raw !== undefined
          ? { "content-type": opts.media ?? "application/json" }
          : {}),
      },
      ...(opts.body !== undefined
        ? { body: JSON.stringify(opts.body) }
        : opts.raw !== undefined
          ? { body: opts.raw }
          : {}),
    },
  );
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  expect(r.headers.get("content-type")).toContain(
    status < 400 ? "application/json" : "application/problem+json",
  );
  expect(r.headers.get("x-request-id")).toBeTruthy();
  const response = doc.paths[path]?.[method]?.responses[String(status)] as
    { content: Record<string, { schema: unknown }> } | undefined;
  expect(response, `undocumented ${method} ${path} ${status}`).toBeTruthy();
  validate(Object.values(response!.content)[0]!.schema, body);
  return body as T;
}
function example(path: string) {
  const rb = doc.paths[path]!.post!.requestBody as {
    content: Record<string, { schema: unknown; example: Record<string, unknown> }>;
  };
  const media = rb.content["application/json"]!;
  validate(media.schema, media.example);
  return media.example;
}
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`insert into projects (id,name) values (${projectId},'openapi-conversation'),(${foreignProject},'foreign-contract')`;
  await t.sql`insert into conversations (id,project_id,title,ended_at) values (${sourceId},${projectId},'source history',now()),(${foreignConv},${foreignProject},'foreign',null)`;
  const bid = uuidv7(),
    vid = uuidv7(),
    fbid = uuidv7(),
    fvid = uuidv7();
  await t.sql`insert into beliefs (id,project_id,subject,attribute) values (${bid},${projectId},'p','database'),(${fbid},${foreignProject},'foreign','private')`;
  await t.sql`insert into belief_versions (id,belief_id,value,valid_from,recorded_from) values (${vid},${bid},${JSON.stringify({ dialect: null })},now(),now()),(${fvid},${fbid},${JSON.stringify("foreign-private-marker")},now(),now())`;
  const file = {
    version: 1,
    kind: "file",
    path: "src/example.ts",
    truncated: true,
    parent_message_id: userId,
    source_type: "PROJECT_FILE",
  };
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time,extracted_at) values (${userId},${sourceId},'user','original directive','2026-10-01T00:00:00Z',now())`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time,memories,generation_status) values (${uuidv7()},${sourceId},'assistant','partial response','2026-10-01T00:00:01Z',${JSON.stringify([vid, fvid, "not-a-uuid"])},'interrupted')`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time,attachment,extracted_at) values (${uuidv7()},${sourceId},'tool','stored file text','2026-10-01T00:00:02Z',${JSON.stringify(file)},now())`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time) values (${uuidv7()},${sourceId},'tool','ordinary tool output','2026-10-01T00:00:03Z')`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time,memories,generation_status) values (${uuidv7()},${sourceId},'assistant','failed response','2026-10-01T00:00:04Z','[]'::jsonb,'failed')`;
  // Real route module in durable mode, deliberately no worker: inspect outbox without executing it.
  app = buildApp({ db: t.db, authToken: token, logStream: { write: () => {} } });
  registerChatRoutes(app, t.db, TEST_MASTER_KEY, {
    durableExtraction: true,
    factory: { languageModel: models, embeddingModel: models },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterAll(async () => {
  await app?.close();
  await t?.close();
  expect(models).not.toHaveBeenCalled();
});
it("artifact examples complete create/commit/resume/read lifecycle without copying or re-extracting inherited Evidence", async () => {
  const createBody = { ...example("/v1/conversations"), project_id: projectId };
  const created = await request<ChatConversation>("/v1/conversations", "post", 200, {
    body: createBody,
  });
  expect(created).toMatchObject({
    project_id: projectId,
    title: "API contract example",
    ended_at: null,
  });
  const committed = await request<ChatCommit>(commitPath, "post", 200, { id: created.id });
  expect(committed.extraction_triggered).toBe(false);
  expect(committed.ended_at).not.toBeNull();
  await request(commitPath, "post", 409, { id: created.id });
  const fork = await request<ChatResume>(resumePath, "post", 201, { body: example(resumePath) });
  expect(fork.id).not.toBe(sourceId);
  expect(fork).toMatchObject({ project_id: projectId, resumed_from: sourceId, ended_at: null });
  expect(fork.messages).toHaveLength(5);
  expect(
    (await t.sql`select count(*)::int as n from messages where conversation_id=${fork.id}`)[0]!.n,
  ).toBe(0);
  expect(
    (await t.sql`select count(*)::int as n from memory_tasks where project_id=${projectId}`)[0]!.n,
  ).toBe(0);
  const detail = await request<ConversationDetail>(detailPath, "get", 200, { id: fork.id });
  expect(detail.messages.map((m) => m.id)).toEqual(fork.messages.map((m) => m.id));
  expect(detail.messages[1]).toMatchObject({
    generation_status: "interrupted",
    memories: [{ subject: "p", value: { dialect: null } }],
  });
  expect(detail.messages[2]).toMatchObject({
    speaker: "tool",
    attachment: { parent_message_id: userId, source_type: "PROJECT_FILE", truncated: true },
  });
  expect(detail.messages[3]!.memories).toBeNull();
  expect(detail.messages[4]).toMatchObject({ generation_status: "failed", memories: [] });
  expect(JSON.stringify(detail)).not.toContain("foreign-private-marker");
  const rows = await request<ConversationListItem[]>(listPath, "get", 200);
  expect(rows.find((r) => r.id === fork.id)).toMatchObject({ message_count: 5 });
  expect(rows.find((r) => r.id === created.id)).toMatchObject({ message_count: 0 });
});
it("commit with pending physical Evidence reports registration, not completed extraction", async () => {
  const id = uuidv7(),
    mid = uuidv7();
  await t.sql`insert into conversations (id,project_id) values (${id},${projectId})`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time) values (${mid},${id},'user','pending directive',now())`;
  expect(await request<ChatCommit>(commitPath, "post", 200, { id })).toMatchObject({
    extraction_triggered: true,
  });
  await request(commitPath, "post", 409, { id });
  const tasks =
    await t.sql`select type,status,payload from memory_tasks where project_id=${projectId} and payload->>'evidence_id'=${mid}`;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    type: "EXTRACT",
    status: "queued",
    payload: { evidence_id: mid },
  });
  expect(
    (await t.sql`select extracted_at from messages where id=${mid}`)[0]!.extracted_at,
  ).toBeNull();
  expect(
    (await t.sql`select count(*)::int as n from observations where evidence_id=${mid}`)[0]!.n,
  ).toBe(0);
});
it("resume archives current open conversation and registers only its own pending Evidence", async () => {
  const current = uuidv7(),
    mid = uuidv7();
  await t.sql`insert into conversations (id,project_id) values (${current},${projectId})`;
  await t.sql`insert into messages (id,conversation_id,speaker,raw_text,msg_time) values (${mid},${current},'user','current pending',now())`;
  const fork = await request<ChatResume>(resumePath, "post", 201, {
    body: { current_conversation_id: current },
  });
  expect(fork.messages).toHaveLength(5);
  expect(
    (await t.sql`select ended_at from conversations where id=${current}`)[0]!.ended_at,
  ).not.toBeNull();
  expect(
    (
      await t.sql`select count(*)::int as n from memory_tasks where project_id=${projectId} and payload->>'evidence_id'=${mid}`
    )[0]!.n,
  ).toBe(1);
  expect(
    (
      await t.sql`select count(*)::int as n from memory_tasks where project_id=${projectId} and payload->>'evidence_id'=${userId}`
    )[0]!.n,
  ).toBe(0);
});
it.each([
  [detailPath, "get", {}],
  [resumePath, "post", { body: {} }],
  [resumePath, "post", { body: { current_conversation_id: foreignConv } }],
] as const)(
  "project checks on %s reject foreign source/current before mutation",
  async (path, method, opts) => {
    const before =
      await t.sql`select id,ended_at from conversations where id in (${sourceId},${foreignConv}) order by id`;
    await request(path, method, 404, {
      ...opts,
      ...(path === detailPath || !("body" in opts) || !("current_conversation_id" in opts.body)
        ? { project: foreignProject }
        : {}),
    });
    expect(
      await t.sql`select id,ended_at from conversations where id in (${sourceId},${foreignConv}) order by id`,
    ).toEqual(before);
  },
);
it.each([
  [listPath, "get", { project: "bad" }],
  [detailPath, "get", { id: "bad" }],
  [commitPath, "post", { id: "bad" }],
  [listPath, "get", { query: "?limit=1001" }],
  [listPath, "get", { query: "?offset=-1" }],
  ["/v1/conversations", "post", { body: { project_id: projectId, title: "manual-corrections" } }],
  [resumePath, "post", { body: { extra: true } }],
  [resumePath, "post", { body: { current_conversation_id: "bad" } }],
] as const)("invalid %s yields structured field errors", async (path, method, opts) => {
  const r = await request<ProblemDetails>(path, method, 400, opts);
  expect(r.errors?.length).toBeGreaterThan(0);
});
it("authentication precedes malformed JSON and path handling", async () => {
  await request("/v1/conversations", "post", 401, { raw: "{broken", auth: false });
  await request(commitPath, "post", 401, { id: "bad", auth: false });
});
it("missing project/conversation behavior matches documented empty list and 404", async () => {
  expect(await request(listPath, "get", 200, { project: uuidv7() })).toEqual([]);
  await request("/v1/conversations", "post", 404, { body: { project_id: uuidv7() } });
  await request(commitPath, "post", 404, { id: uuidv7() });
});
it("pagination retains unavailable-history rows, while detail/resume/commit fail closed", async () => {
  const bad = uuidv7();
  await t.sql`insert into conversations (id,project_id,title,meta) values (${bad},${projectId},'bad-context',${JSON.stringify({ resume: { version: 1, from: sourceId, message_ids: [uuidv7()] } })})`;
  const rows = await request<ConversationListItem[]>(listPath, "get", 200, {
    query: "?limit=1000&extra=ignored",
  });
  expect(rows.find((r) => r.id === bad)).toMatchObject({
    message_count: null,
    history_error: "unavailable",
  });
  const page = await request<ConversationListItem[]>(listPath, "get", 200, {
    query: "?limit=1&offset=1",
  });
  expect(page).toEqual(rows.slice(1, 2));
  await request(detailPath, "get", 409, { id: bad });
  await request(resumePath, "post", 409, { id: bad, body: {} });
  await request(commitPath, "post", 409, { id: bad });
  expect((await t.sql`select ended_at from conversations where id=${bad}`)[0]!.ended_at).toBeNull();
});
it("reserved correction conversation cannot be resumed", async () => {
  const id = uuidv7();
  await t.sql`insert into conversations (id,project_id,title) values (${id},${projectId},'manual-corrections')`;
  await request(resumePath, "post", 409, { id, body: {} });
});
it.each([
  [415, "text/xml", "<message/>"],
  [413, "application/json", JSON.stringify({ title: "x".repeat(1048576) })],
] as const)("parser rejection %s has the generated problem body", async (status, media, raw) => {
  await request("/v1/conversations", "post", status, { media, raw });
});
