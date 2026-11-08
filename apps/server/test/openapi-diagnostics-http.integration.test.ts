import { requestOversizeHeaders } from "./fixtures/oversize-request.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2, MockEmbeddingModelV2 } from "ai/test";
import type { DoctorReport, RecallResult, ProblemDetails } from "@mnemic/shared";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { DEFAULT_FEATURE_FLAGS } from "@mnemic/shared/flags";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { readFeatureFlags } from "../src/flags/repository.js";
import { bagOfWordsVector } from "./fixtures/bag-embedding.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
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
ajv.addSchema({ components: doc.components }, "diagnostic");
const recallPath = "/projects/{projectId}/recall",
  probePath = "/v1/doctor/probe";
const project = uuidv7(),
  foreign = uuidv7(),
  providerName = "diagnostic-" + uuidv7();
const secret = "offline-diagnostic-secret-937446",
  token = "diagnostic-contract-token-000000",
  trustedOrigin = "https://trusted-web.invalid";
const fixtureFlags = { ...DEFAULT_FEATURE_FLAGS, read_time_reinforcement: true };
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  base: string,
  savedFlags: Awaited<ReturnType<typeof readFeatureFlags>>;
let savedProviders: unknown[] = [];
let failLanguage = false,
  failEmbedding = false;
const logs: string[] = [];
const generate = vi.fn(async () => {
  if (failLanguage) throw Error(`upstream credential ${secret}`);
  return {
    content: [{ type: "text" as const, text: "OK" }],
    finishReason: "stop" as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  };
});
const embed = vi.fn(async ({ values }: { values: string[] }) => {
  if (failEmbedding) throw Error(`embedding credential ${secret}`);
  return { embeddings: values.map((v) => bagOfWordsVector(v)) };
});
const languageFactory = vi.fn(() => new MockLanguageModelV2({ doGenerate: generate }));
const embeddingFactory = vi.fn(() => new MockEmbeddingModelV2({ doEmbed: embed }));
function responseSchema(path: string, method: "get" | "post", status: number) {
  const r = doc.paths[path]?.[method]?.responses[String(status)] as
    { content: Record<string, { schema: unknown }> } | undefined;
  expect(r, `undocumented ${method} ${path} ${status}`).toBeTruthy();
  return Object.values(r!.content)[0]!.schema;
}
function validate(schema: unknown, body: unknown) {
  const v = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"diagnostic#/components/')),
  );
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
async function request<T = unknown>(
  path: string,
  method: "get" | "post",
  status: number,
  opts: {
    project?: string;
    query?: string;
    body?: unknown;
    raw?: string;
    media?: string;
    declaredBodyBytes?: number;
    auth?: boolean;
    origin?: string;
  } = {},
) {
  const declaredBytes = opts.declaredBodyBytes;
  const transport =
    declaredBytes === undefined
      ? fetch
      : (url: string, init: RequestInit) =>
          requestOversizeHeaders(url, init.headers ?? {}, declaredBytes, init.method ?? "POST");
  const r = await transport(
    base + path.replace("{projectId}", opts.project ?? project) + (opts.query ?? ""),
    {
      method: method.toUpperCase(),
      headers: {
        ...(opts.auth === false ? {} : { authorization: `Bearer ${token}` }),
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts.body !== undefined ||
        opts.raw !== undefined ||
        opts.declaredBodyBytes !== undefined
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
  expect(r.headers.get("x-request-id")).toBeTruthy();
  expect(r.headers.get("content-type")).toContain(
    status === 200 ? "application/json" : "application/problem+json",
  );
  if (status === 200) expect(r.headers.get("cache-control")).toBe("no-store");
  validate(responseSchema(path, method, status), body);
  expect(JSON.stringify(body)).not.toContain(secret);
  return body as T;
}
function example(path: string) {
  const rb = doc.paths[path]!.post!.requestBody as {
    content: Record<string, { schema: unknown; example: unknown }>;
  };
  const m = rb.content["application/json"]!;
  validate(m.schema, m.example);
  return m.example;
}
async function setFlags(flags: typeof fixtureFlags) {
  await t.sql`update feature_flags set flags=${JSON.stringify(flags)}::jsonb where scope='server'`;
}
async function memoryState() {
  return t.sql`select id,salience,confidence,importance,evidence_count,status from beliefs where project_id=${project} order by id`;
}
async function traceCount() {
  return (
    await t.sql`select count(*)::int as n from retrieval_traces where project_id=${project}`
  )[0]!.n;
}
beforeAll(async () => {
  t = await setupTestDb();
  savedProviders = (await t.sql`select to_jsonb(p) as row from provider_configs p`).map(
    (r) => r.row,
  );
  savedFlags = await readFeatureFlags(t.db);
  await setFlags(fixtureFlags);
  await t.sql`delete from provider_configs`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: providerName,
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid/v1",
    apiKey: secret,
    models: { chat: "offline-chat", extraction: "offline-extract", embedding: "offline-1024" },
  });
  await t.sql`insert into projects (id,name) values (${project},'diagnostic-contract'),(${foreign},'foreign-contract')`;
  for (const [pid, value, status] of [
    ...Array.from({ length: 6 }, () => [project, "PostgreSQL", "active"] as const),
    [foreign, "foreign-private-PostgreSQL", "active"],
    [project, "deleted-private-PostgreSQL", "deleted"],
  ] as const) {
    const id = uuidv7(),
      vid = uuidv7();
    await t.sql`insert into beliefs (id,project_id,subject,attribute,salience,confidence,importance,status) values (${id},${pid},${"subject-" + id},'database',0.4,0.6,0.8,${status})`;
    await t.sql`insert into belief_versions (id,belief_id,value,valid_from,recorded_from) values (${vid},${id},${JSON.stringify(value)},now(),now())`;
    await t.sql`update beliefs set current_version_id=${vid} where id=${id}`;
    const vector = "[" + bagOfWordsVector(value).join(",") + "]";
    await t.sql`insert into memory_embeddings (id,belief_version_id,embedding,model) values (${uuidv7()},${vid},${vector}::vector,'offline-1024')`;
  }
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    corsOrigin: trustedOrigin,
    providerFactory: { languageModel: languageFactory, embeddingModel: embeddingFactory },
    logStream: { write: (chunk) => logs.push(chunk) },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
beforeEach(() => {
  generate.mockClear();
  embed.mockClear();
  languageFactory.mockClear();
  embeddingFactory.mockClear();
  failLanguage = false;
  failEmbedding = false;
});
afterAll(async () => {
  await app?.close();
  if (t) {
    try {
      await t.sql.begin(async (tx) => {
        await tx`delete from provider_configs`;
        if (savedProviders.length)
          await tx`insert into provider_configs select * from jsonb_populate_recordset(null::provider_configs,${JSON.stringify(savedProviders)}::jsonb)`;
        await tx`update feature_flags set flags=${JSON.stringify(savedFlags.flags)}::jsonb,revision=${savedFlags.revision} where scope='server'`;
        await tx`delete from model_usage where provider_name=${providerName}`;
      });
    } finally {
      await t.close();
    }
  }
  expect(logs.join("")).not.toContain(secret);
});
it("GET diagnostic resolves adapters but has zero model invocations and zero usage rows", async () => {
  const r = await request<DoctorReport>("/v1/doctor", "get", 200);
  expect(r).toMatchObject({ ok: true, probe: false, configSource: "server" });
  for (const name of ["chat", "extraction", "embedding"])
    expect(r.checks.find((c) => c.name === name)?.status).toBe("skipped");
  expect(languageFactory).toHaveBeenCalledTimes(2);
  expect(embeddingFactory).toHaveBeenCalledOnce();
  expect(generate).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
  expect(
    (
      await t.sql`select count(*)::int as n from model_usage where provider_name=${providerName}`
    )[0]!.n,
  ).toBe(0);
});
it("published explicit probe example invokes three offline SDK slots, records usage and writes no memory trace", async () => {
  const state = await memoryState(),
    traces = await traceCount();
  const before = (
    await t.sql`select count(*)::int as n from model_usage where provider_name=${providerName} and purpose='probe'`
  )[0]!.n;
  const r = await request<DoctorReport>(probePath, "post", 200, {
    body: example(probePath),
    query: "?ignored=yes",
  });
  expect(r).toMatchObject({ ok: true, probe: true });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(embed).toHaveBeenCalledOnce();
  for (const name of ["chat", "extraction", "embedding"])
    expect(r.checks.find((c) => c.name === name)?.status).toBe("ok");
  const usage =
    await t.sql`select slot,status,project_id,conversation_id from model_usage where provider_name=${providerName} and purpose='probe' order by started_at,id`;
  expect(usage.length - before).toBe(3);
  expect(
    usage.every(
      (u) => u.status === "success" && u.project_id === null && u.conversation_id === null,
    ),
  ).toBe(true);
  expect(new Set(usage.map((u) => u.slot))).toEqual(new Set(["chat", "extraction", "embedding"]));
  expect(await memoryState()).toEqual(state);
  expect(await traceCount()).toBe(traces);
});
it("upstream probe failures are safe HTTP200 reports, not raw exceptions or automatic retries", async () => {
  failLanguage = true;
  const r = await request<DoctorReport>(probePath, "post", 200, { body: {} });
  expect(r).toMatchObject({ ok: false, probe: true });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(embed).toHaveBeenCalledOnce();
  expect(
    r.checks
      .filter((c) => c.status === "error")
      .map((c) => c.name)
      .sort(),
  ).toEqual(["chat", "extraction"]);
  expect(JSON.stringify(r)).not.toContain("upstream");
});
it("doctor remains HTTP200 with ok=false when database is not configured", async () => {
  const service = buildApp({ authToken: token, logStream: { write: () => {} } });
  const url = await service.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const [path, method] of [
      ["/v1/doctor", "get"],
      [probePath, "post"],
    ] as const) {
      const r = await fetch(url + path, {
        method: method.toUpperCase(),
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "post" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "post" ? { body: "{}" } : {}),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as DoctorReport;
      validate(responseSchema(path, method, 200), body);
      expect(body.ok).toBe(false);
      expect(body.checks.find((c) => c.name === "database")?.status).toBe("error");
    }
  } finally {
    await service.close();
  }
  expect(generate).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
});
it("published recall example selects only active project memory and persists the non-reinforcing score trace", async () => {
  const state = await memoryState();
  const r = await request<RecallResult>(recallPath, "post", 200, {
    body: example(recallPath),
    query: "?reinforce=true",
  });
  expect(r.project_id).toBe(project);
  expect(r.abstained).toBe(false);
  expect(r.candidates).toHaveLength(5);
  expect(r.trace).toMatchObject({
    reinforce_enabled: false,
    candidate_count: 6,
    truncated: false,
    flags_snapshot: { flags: { read_time_reinforcement: false } },
  });
  expect(r.candidates.every((c) => c.value === "PostgreSQL")).toBe(true);
  expect(embed).toHaveBeenCalledOnce();
  expect(generate).not.toHaveBeenCalled();
  const [trace] =
    await t.sql`select candidates,reinforce_enabled,query_text from retrieval_traces where id=${r.trace.id} and project_id=${project}`;
  expect(trace!.candidates).toEqual(r.trace.candidates);
  expect(trace!.query_text).toBe("PostgreSQL");
  expect(trace!.reinforce_enabled).toBe(false);
  expect(r.trace.candidates.every((c) => !("value" in c))).toBe(true);
  expect(await memoryState()).toEqual(state);
  const usage =
    await t.sql`select project_id,conversation_id,status from model_usage where provider_name=${providerName} and purpose='embedding_query'`;
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ project_id: project, conversation_id: null, status: "success" });
});
it("keyword-only no-answer path abstains without invoking any model", async () => {
  await setFlags({ ...fixtureFlags, retrieval_vector: false });
  try {
    const r = await request<RecallResult>(recallPath, "post", 200, {
      body: { query: "absent-canonical-term" },
    });
    expect(r.abstained).toBe(true);
    expect(r.candidates).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(embeddingFactory).not.toHaveBeenCalled();
  } finally {
    await setFlags(fixtureFlags);
  }
});
it("embedding failure degrades to keyword recall without leaking errors", async () => {
  failEmbedding = true;
  const r = await request<RecallResult>(recallPath, "post", 200, { body: { query: "PostgreSQL" } });
  expect(r.abstained).toBe(false);
  expect(r.candidates).toHaveLength(5);
  expect(r.trace.candidates.every((c) => c.vectorScore === null)).toBe(true);
  expect(embed).toHaveBeenCalledOnce();
  expect(generate).not.toHaveBeenCalled();
});
it("unsupported persistent flags produce documented500 before any model invocation or trace", async () => {
  const traces = await traceCount();
  await setFlags({ ...fixtureFlags, reranker: true });
  try {
    const r = await request<ProblemDetails>(recallPath, "post", 500, {
      body: { query: "PostgreSQL" },
    });
    expect(r.detail).toBe("手动召回失败；未自动重试，检索轨迹可能已写入");
    expect(await traceCount()).toBe(traces);
    expect(embeddingFactory).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  } finally {
    await setFlags(fixtureFlags);
  }
});
it("missing project returns404 without any SDK invocation", async () => {
  await request(recallPath, "post", 404, { project: uuidv7(), body: { query: "PostgreSQL" } });
  expect(embed).not.toHaveBeenCalled();
  expect(embeddingFactory).not.toHaveBeenCalled();
});
it.each(
  [recallPath, probePath].flatMap((path) =>
    [trustedOrigin, "https://evil.invalid", "null"].map((origin) => ({ path, origin })),
  ),
)("Origin=$origin is rejected before parsing on $path", async ({ path, origin }) => {
  await request(path, "post", 403, { origin, raw: "{broken" });
  expect(generate).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
});
it.each([recallPath, probePath])(
  "non-JSON media on %s returns415 without invocation",
  async (path) => {
    await request(path, "post", 415, { media: "text/plain", raw: "{}" });
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  },
);
it.each([
  ["/v1/doctor", "get", { query: "?probe=true" }],
  [probePath, "post", { body: { probe: true } }],
  [probePath, "post", { body: null }],
  [recallPath, "post", { body: { query: "" } }],
  [recallPath, "post", { body: { query: "x", reinforce: true } }],
  [recallPath, "post", { project: "bad", body: { query: "x" } }],
] as const)(
  "invalid %s request returns structured400 without invocation",
  async (path, method, opts) => {
    const r = await request<ProblemDetails>(path, method, 400, opts);
    expect(r.errors?.length).toBeGreaterThan(0);
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  },
);
it.each([recallPath, probePath])(
  "auth401 precedes malformed JSON and Origin rejection on %s",
  async (path) => {
    await request(path, "post", 401, { auth: false, origin: trustedOrigin, raw: "{broken" });
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  },
);
it.each([recallPath, probePath])(
  "body limit413 on %s uses the documented problem schema",
  async (path) => {
    await request(path, "post", 413, { declaredBodyBytes: 1048577 });
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  },
);
