import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { uuidv7 } from "uuidv7";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { memoryExportDb } from "./fixtures/memory-export-db.js";
import { buildApp } from "../src/app.js";
import { decodeMemoryExport } from "../src/data-export/codec.js";
import { MEMORY_EXPORT_TABLES } from "../src/data-export/format.js";
import type { OpenApiDocument } from "../scripts/openapi.js";
import { requestOversizeHeaders } from "./fixtures/oversize-request.js";
const path = "/v1/exports/memory",
  token = "export-offline-token-000000000000000",
  headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const secret = "sk-export-offline-sensitive-123456789012345678901234";
const logs: string[] = [];
const models = vi.fn(() => {
  throw Error("export must never resolve a model");
});
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;
const ajv = new Ajv({ strict: false, formats: { uuid: true, "date-time": true, binary: true } });
ajv.addSchema({ components: doc.components }, "export");
function validate(status: number, media: string, body: unknown) {
  const response = doc.paths[path]!.post!.responses![status] as {
    content: Record<string, { schema: unknown }>;
  };
  const schema = JSON.parse(
    JSON.stringify(response.content[media]!.schema).replaceAll(
      '"#/components/',
      '"export#/components/',
    ),
  );
  const v = ajv.compile(schema);
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
}
let t: Awaited<ReturnType<typeof memoryExportDb>>, app: ReturnType<typeof buildApp>, base: string;
beforeAll(async () => {
  t = await memoryExportDb();
  app = buildApp({
    db: t.db,
    authToken: token,
    providerFactory: { languageModel: models, embeddingModel: models },
    rateLimit: {
      ip: { capacity: 100, refillPerSecond: 100 },
      token: { capacity: 100, refillPerSecond: 100 },
    },
    logStream: {
      write: (s) => {
        logs.push(s);
      },
    },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}, 180000);
afterEach(async () => {
  for (const table of [...MEMORY_EXPORT_TABLES].reverse()) await t.sql`delete from ${t.sql(table)}`;
  expect(models).not.toHaveBeenCalled();
  expect(logs.join("")).not.toContain(secret);
});
afterAll(async () => {
  await app?.close();
  await t?.close();
});
async function request(
  status: number,
  options: { body?: unknown; raw?: string; media?: string; query?: string; auth?: boolean } = {},
  origin = base,
) {
  const response = await fetch(origin + path + (options.query ?? ""), {
    method: "POST",
    headers: {
      ...(options.auth === false ? {} : { authorization: headers.authorization }),
      "content-type": options.media ?? "application/json",
    },
    body:
      options.raw ??
      JSON.stringify(Object.hasOwn(options, "body") ? options.body : { scope: "instance" }),
  });
  expect(response.status).toBe(status);
  expect(response.headers.get("x-request-id")).toBeTruthy();
  const text = await response.text();
  if (status !== 200) {
    validate(status, "application/problem+json", JSON.parse(text));
    expect(text).not.toContain(secret);
  }
  return { response, text };
}
it("submitted OpenAPI example executes over real HTTP and returns all projects without treating a filter as authorization", async () => {
  const requestBody = doc.paths[path]!.post!.requestBody as {
    content: Record<string, { example: unknown }>;
  };
  const a = uuidv7(),
    b = uuidv7();
  await t.sql`insert into projects(id,name) values(${a},'one'),(${b},${secret})`;
  await t.sql`insert into audit_log(id,actor,action,meta) values(${uuidv7()},'legacy','unknown',${JSON.stringify({ private: secret })}::jsonb)`;
  const { response, text } = await request(200, {
    body: requestBody.content["application/json"]!.example,
  });
  validate(200, "application/x-ndjson", text);
  const archive = decodeMemoryExport(Buffer.from(text));
  expect(archive.counts.projects).toBe(2);
  expect(archive.counts.audit_log).toBe(1);
  expect(text).toContain(secret); // Authorized lossless raw export, not the safe audit API projection.
  expect(response.headers.get("content-type")).toMatch(/^application\/x-ndjson/);
  expect(response.headers.get("content-disposition")).toBe(
    `attachment; filename="mnemic-memory-${archive.manifest.export_id}.jsonl"`,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const [receipt] = await t.sql`select * from audit_log where action='memory.export'`;
  expect(receipt).toMatchObject({ target: archive.manifest.export_id, decision: "prepared" });
  expect(receipt!.meta).toMatchObject({
    rows: 3,
    bytes: Buffer.byteLength(text),
    sha256: archive.sha256,
  });
  expect(JSON.stringify(receipt)).not.toContain(secret);
  const audit = await fetch(
    `${base}/v1/audit-log?action=memory.export&target=${archive.manifest.export_id}`,
    { headers },
  );
  expect(audit.status).toBe(200);
  expect(((await audit.json()) as { items: unknown[] }).items).toHaveLength(1);
});
it.each([
  {},
  { scope: "project" },
  { scope: "instance", project_id: uuidv7() },
  { scope: "instance", tables: ["provider_configs"] },
  null,
  [],
])("rejects non-explicit or expanded instance request %j before persistence", async (body) => {
  const { response } = await request(400, { body });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it("rejects unknown query, malformed JSON and empty body without prepared audit", async () => {
  await request(400, { query: "?project_id=" + uuidv7() });
  await request(400, { raw: "{broken" });
  await request(400, { raw: "" });
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it.each(["text/xml", "text/plain", "application/octet-stream"])(
  "rejects unsupported media %s before preparation",
  async (media) => {
    const { response } = await request(415, { media });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await t.sql`select id from audit_log`).toEqual([]);
  },
);
it("accepts JSON charset and produces a complete zero-row archive", async () => {
  const { text } = await request(200, { media: "application/json; charset=utf-8" });
  expect(decodeMemoryExport(Buffer.from(text)).records).toEqual([]);
});
it("oversized request body is413, without an archive or receipt", async () => {
  const r = await requestOversizeHeaders(base + path, headers, 1048577);
  expect(r.status).toBe(413);
  validate(413, "application/problem+json", await r.json());
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it("oversized source row returns fixed413 and no source fragment, download header or receipt", async () => {
  await t.sql`insert into projects(id,name) values(${uuidv7()},${secret + "x".repeat(1048576)})`;
  const { response } = await request(413);
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it("audit write failure returns fixed500 without sending prepared bytes", async () => {
  await t.sql`insert into projects(id,name) values(${uuidv7()},${secret})`;
  await t.sql`alter table audit_log add constraint reject_export check(action <> 'memory.export') not valid`;
  try {
    const { response, text } = await request(500);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text).detail).toBe("服务器内部错误");
  } finally {
    await t.sql`alter table audit_log drop constraint reject_export`;
  }
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
it("root authentication precedes malformed input, media checks and any database property access", async () => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error(secret);
    },
  });
  const denied = buildApp({
    db,
    authToken: token,
    logStream: {
      write: (s) => {
        logs.push(s);
      },
    },
  });
  const origin = await denied.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request(401, { auth: false, raw: "{broken", media: "text/xml" }, origin);
    expect(reads).toBe(0);
  } finally {
    await denied.close();
  }
});
it("root rate limit rejects before DB and unexpected database errors remain fixed500", async () => {
  let reads = 0;
  const db = new Proxy({} as PostgresJsDatabase, {
    get() {
      reads++;
      throw Error(secret);
    },
  });
  const failed = buildApp({
    db,
    authToken: token,
    rateLimit: { ip: { capacity: 1, refillPerSecond: 0.001 } },
    logStream: {
      write: (s) => {
        logs.push(s);
      },
    },
  });
  const origin = await failed.listen({ host: "127.0.0.1", port: 0 });
  try {
    const { response, text } = await request(500, {}, origin);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text).detail).toBe("服务器内部错误");
    const before = reads;
    const limited = await request(429, {}, origin);
    expect(limited.response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(reads).toBe(before);
  } finally {
    await failed.close();
  }
});
it("no database means404 and GET never triggers a download or audit", async () => {
  const bare = buildApp({ authToken: token, logStream: { write: () => {} } });
  const origin = await bare.listen({ host: "127.0.0.1", port: 0 });
  try {
    await request(404, {}, origin);
  } finally {
    await bare.close();
  }
  expect((await fetch(base + path, { headers })).status).toBe(404);
  expect(await t.sql`select id from audit_log`).toEqual([]);
});
