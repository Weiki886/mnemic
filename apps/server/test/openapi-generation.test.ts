import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createOpenApiDocument,
  serializeOpenApi,
  checkOpenApiArtifact,
  runOpenApiCommand,
} from "../scripts/openapi.js";
import { Ajv } from "ajv";
it("generation is deterministic, scoped and never includes environment-specific credentials", async () => {
  const a = createOpenApiDocument(),
    b = createOpenApiDocument();
  expect(a).toEqual(b);
  expect(a.openapi).toBe("3.0.3");
  expect(Object.keys(a.paths).sort()).toEqual([
    "/health",
    "/pending",
    "/pending/{id}/confirm",
    "/pending/{id}/reject",
    "/projects/{projectId}/approvals",
    "/projects/{projectId}/beliefs",
    "/projects/{projectId}/beliefs/{id}",
    "/projects/{projectId}/beliefs/{id}/correct",
    "/projects/{projectId}/beliefs/{id}/delete",
    "/projects/{projectId}/beliefs/{id}/resolutions",
    "/projects/{projectId}/beliefs/{id}/restore",
    "/projects/{projectId}/conversations",
    "/projects/{projectId}/conversations/{id}",
    "/projects/{projectId}/conversations/{id}/resume",
    "/projects/{projectId}/recall",
    "/projects/{projectId}/status",
    "/projects/{projectId}/usage",
    "/projects/{projectId}/usage/export",
    "/providers",
    "/providers/{id}",
    "/v1/config",
    "/v1/config/flags",
    "/v1/conversations",
    "/v1/conversations/{id}/commit",
    "/v1/doctor",
    "/v1/doctor/probe",
  ]);
  expect(Object.keys(a.paths["/health"]!).sort()).toEqual(["get", "head"]);
  expect(Object.keys(a.paths["/v1/config/flags"]!).sort()).toEqual(["get", "put"]);
  expect(a.security).toEqual([{ bearerAuth: [] }]);
  expect(a.paths["/health"]!.get!.security).toEqual([]);
  expect(a.components?.securitySchemes?.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
  expect(JSON.stringify(a)).not.toMatch(/sk-|MASTER_KEY|\.env/);
  expect(await serializeOpenApi(a)).toBe(await serializeOpenApi(b));
});
it("checked artifact matches generation and drift is rejected rather than silently overwritten", async () => {
  const text = await readFile(new URL("../../../docs/openapi.json", import.meta.url), "utf8");
  await expect(checkOpenApiArtifact(text)).resolves.toBeUndefined();
  await expect(checkOpenApiArtifact(text.replace('"3.0.3"', '"3.0.2"'))).rejects.toThrow(
    "OpenAPI artifact is out of date",
  );
});
it("generated problem oneOf enforces URI/code pairing and legacy compatibility", () => {
  const doc = createOpenApiDocument(),
    ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({ components: doc.components }, "mnemic");
  const validate = ajv.compile({ $ref: "mnemic#/components/schemas/ProblemDetails" });
  expect(
    validate({
      type: "https://mnemic.dev/errors/not-found",
      status: 404,
      title: "Not Found",
      code: "NOT_FOUND",
    }),
  ).toBe(true);
  expect(
    validate({ type: "about:blank", status: 404, title: "Not Found", code: "NOT_FOUND" }),
  ).toBe(true);
  expect(
    validate({
      type: "https://mnemic.dev/errors/conflict",
      status: 404,
      title: "Not Found",
      code: "NOT_FOUND",
    }),
  ).toBe(false);
});

it("unknown CLI arguments fail before modifying the checked artifact", async () => {
  const file = new URL("../../../docs/openapi.json", import.meta.url),
    before = await readFile(file, "utf8");
  await expect(runOpenApiCommand(["--output", "private-path"])).rejects.toThrow(
    "only accepts --check",
  );
  expect(await readFile(file, "utf8")).toBe(before);
});
it("published contract declares the repository's actual Apache license", () => {
  expect(createOpenApiDocument().info.license).toEqual({
    name: "Apache License 2.0",
    url: "https://www.apache.org/licenses/LICENSE-2.0.html",
  });
});

it("memory operations use scoped UUID parameters, bearer security and the server pagination default", () => {
  const doc = createOpenApiDocument();
  const list = doc.paths["/projects/{projectId}/beliefs"]!.get!;
  expect(list.parameters).toContainEqual(
    expect.objectContaining({
      name: "projectId",
      in: "path",
      required: true,
      schema: expect.objectContaining({ type: "string", format: "uuid" }),
    }),
  );
  expect(list.parameters).toContainEqual(
    expect.objectContaining({
      name: "limit",
      in: "query",
      schema: expect.objectContaining({ type: "integer", default: 200, maximum: 1000 }),
    }),
  );
  const base = "/projects/{projectId}/beliefs/{id}";
  for (const [suffix, method] of [
    ["", "get"],
    ["/resolutions", "get"],
    ["/correct", "post"],
    ["/delete", "post"],
    ["/restore", "post"],
  ] as const) {
    const op = doc.paths[base + suffix]![method]!;
    expect(op.security).toBeUndefined(); // inherit root bearer
    expect(op.parameters).toContainEqual(
      expect.objectContaining({ name: "id", in: "path", required: true }),
    );
    expect(op.responses).toHaveProperty("404");
  }
  const components = doc.components!.schemas! as Record<string, { required?: string[] }>;
  expect(components.BeliefDetail!.required).toContain("current_value");
  expect(components.BeliefVersion!.required).toContain("value");
});
it("arbitrary JSON is required but may be null; nullable enums accept actual historical nulls", () => {
  const doc = createOpenApiDocument(),
    ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({ components: doc.components }, "memory");
  const valid = ajv.compile({ $ref: "memory#/components/schemas/BeliefList" });
  const row = {
    id: "01900000-0000-7000-8000-000000000001",
    subject: "p",
    attribute: "x",
    type: null,
    status: "active",
    is_profile: false,
    confidence: null,
    salience: 0,
    importance: 1,
    evidence_count: 1,
    created_at: "2026-10-31T00:00:00Z",
    current_value: null,
  };
  expect(valid([row]), JSON.stringify(valid.errors)).toBe(true);
  for (const current_value of [true, 1, "value", [null], { nested: null }])
    expect(valid([{ ...row, current_value }])).toBe(true);
  const { current_value: _v, ...missing } = row;
  expect(valid([missing])).toBe(false);
});
it("normalizing response nullability never mutates shared query enums or runtime Zod schemas", async () => {
  const { MemoryTypeSchema, MemoryListQuerySchema } = await import("@mnemic/shared/memory");
  createOpenApiDocument();
  expect(MemoryTypeSchema.options).toEqual(["fact", "preference", "decision", "progress"]);
  expect(MemoryListQuerySchema.safeParse({ type: null }).success).toBe(false);
  const op = createOpenApiDocument().paths["/projects/{projectId}/beliefs"]!.get!;
  expect(op.parameters).toContainEqual(
    expect.objectContaining({
      name: "type",
      schema: expect.objectContaining({ enum: ["fact", "preference", "decision", "progress"] }),
    }),
  );
});

it("conversation operation statuses and input contracts match the existing lifecycle", () => {
  const doc = createOpenApiDocument();
  const create = doc.paths["/v1/conversations"]!.post!;
  expect(create.responses).toHaveProperty("200");
  expect(create.responses).not.toHaveProperty("201");
  const resume = doc.paths["/projects/{projectId}/conversations/{id}/resume"]!.post!;
  expect(resume.responses).toHaveProperty("201");
  expect(resume.parameters).toContainEqual(
    expect.objectContaining({ name: "projectId", in: "path", required: true }),
  );
  const commit = doc.paths["/v1/conversations/{id}/commit"]!.post!;
  expect(commit.requestBody).toBeUndefined();
  expect(commit.parameters).toContainEqual(
    expect.objectContaining({ name: "id", schema: expect.objectContaining({ format: "uuid" }) }),
  );
  expect(doc.paths["/projects/{projectId}/conversations"]!.get!.parameters).toContainEqual(
    expect.objectContaining({
      name: "limit",
      schema: expect.objectContaining({ default: 200, maximum: 1000 }),
    }),
  );
  const schemas = doc.components!.schemas! as Record<
    string,
    { required?: string[]; properties?: Record<string, unknown> }
  >;
  expect(schemas.ConversationDetail!.required).toContain("messages");
  expect(schemas.ConversationMessage!.required).toContain("memories");
});

it("provider input credentials are write-only while public snapshots omit credential fields", () => {
  const sentinel = "private-contract-env-sentinel-937446";
  vi.stubEnv("MNEMIC_AUTH_TOKEN", sentinel);
  try {
    const doc = createOpenApiDocument();
    expect(JSON.stringify(doc)).not.toContain(sentinel);
    const post = doc.paths["/providers"]!.post!;
    expect(post.responses).toHaveProperty("201");
    const body = post.requestBody as {
      content: Record<string, { schema: { properties: Record<string, { writeOnly?: boolean }> } }>;
    };
    expect(body.content["application/json"]!.schema.properties.api_key!.writeOnly).toBe(true);
    expect(doc.paths["/providers/{id}"]!.patch!.responses).toHaveProperty("409");
    expect(doc.paths["/projects/{projectId}/status"]!.get!.parameters).toContainEqual(
      expect.objectContaining({ name: "conversation_id", in: "query", required: true }),
    );
    const schemas = doc.components!.schemas! as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(schemas.LegacyProvider!.properties).toHaveProperty("apiKeyMasked");
    expect(schemas.ProviderConfig!.properties).not.toHaveProperty("apiKeyMasked");
    expect(schemas.ProviderConfig!.properties).not.toHaveProperty("api_key");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("diagnostic and recall contracts distinguish read-only reports from explicit invocations", () => {
  const doc = createOpenApiDocument();
  expect(doc.paths["/v1/doctor"]!.get!.responses).toHaveProperty("200");
  expect(doc.paths["/v1/doctor/probe"]!.post!.responses).toHaveProperty("403");
  expect(doc.paths["/projects/{projectId}/recall"]!.get).toBeUndefined();
  expect(doc.paths["/projects/{projectId}/recall"]!.post!.parameters).toContainEqual(
    expect.objectContaining({ name: "projectId", in: "path", required: true }),
  );
  const schemas = doc.components!.schemas! as Record<
    string,
    { properties?: Record<string, { enum?: unknown[] }> }
  >;
  expect(schemas.ReadDoctorReport!.properties!.probe!.enum).toEqual([false]);
  expect(schemas.ProbeDoctorReport!.properties!.probe!.enum).toEqual([true]);
});

it("pending contracts preserve global ID decisions and actual action-specific outputs", () => {
  const doc = createOpenApiDocument();
  const list = doc.paths["/pending"]!.get!;
  expect(list.parameters).toContainEqual(
    expect.objectContaining({ name: "project_id", in: "query", required: true }),
  );
  for (const action of ["confirm", "reject"] as const) {
    const op = doc.paths[`/pending/{id}/${action}`]!.post!;
    expect(op.requestBody).toBeUndefined();
    expect(op.parameters).toContainEqual(
      expect.objectContaining({
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      }),
    );
    expect(op.responses).toHaveProperty("404");
    expect(op.responses).not.toHaveProperty("409");
  }
  const schemas = doc.components!.schemas! as Record<
    string,
    { required?: string[]; properties?: Record<string, { enum?: string[] }> }
  >;
  expect(schemas.PendingRow!.required).toEqual(
    expect.arrayContaining(["candidate", "gateScores", "decidedAt"]),
  );
  expect(schemas.ConfirmPendingResult!.properties!.status!.enum).toEqual(["confirmed"]);
  expect(schemas.RejectPendingResult!.properties!.status!.enum).toEqual(["rejected"]);
});

it("usage contracts preserve exact string counters, strict query defaults and JSON versus CSV media", () => {
  const doc = createOpenApiDocument();
  const report = doc.paths["/projects/{projectId}/usage"]!.get!;
  const exporting = doc.paths["/projects/{projectId}/usage/export"]!.get!;
  expect(report.parameters).toContainEqual(
    expect.objectContaining({
      name: "group_limit",
      schema: expect.objectContaining({ default: 200, maximum: 1000 }),
    }),
  );
  expect(report.parameters).toContainEqual(
    expect.objectContaining({
      name: "group_by",
      schema: expect.objectContaining({ default: "day" }),
    }),
  );
  expect(exporting.parameters).toContainEqual(
    expect.objectContaining({
      name: "format",
      schema: expect.objectContaining({ default: "json", enum: ["json", "csv"] }),
    }),
  );
  const response = exporting.responses["200"] as {
    content: Record<string, { schema: unknown }>;
    headers: Record<string, unknown>;
  };
  expect(Object.keys(response.content).sort()).toEqual(["application/json", "text/csv"]);
  expect(response.content["text/csv"]!.schema).toEqual({ type: "string" });
  expect(response.headers).toHaveProperty("X-Next-After");
  const schemas = doc.components!.schemas! as Record<
    string,
    { properties: Record<string, { type?: string; nullable?: boolean; pattern?: string }> }
  >;
  expect(schemas.UsageExportPage!.properties).toHaveProperty("next_after");
  expect(JSON.stringify(schemas.UsageReport)).toContain('"reported":{"type":"string"');
});

it("approval audit documents client-report receipts, idempotent status codes and bounded offset pages", () => {
  const doc = createOpenApiDocument();
  const path = doc.paths["/projects/{projectId}/approvals"]!;
  expect(Object.keys(path).sort()).toEqual(["get", "post"]);
  expect(path.post!.responses).toHaveProperty("200");
  expect(path.post!.responses).toHaveProperty("201");
  expect(path.post!.responses).toHaveProperty("409");
  expect(path.get!.parameters).toContainEqual(
    expect.objectContaining({ name: "limit", schema: expect.objectContaining({ default: 50 }) }),
  );
  expect(path.get!.parameters).toContainEqual(
    expect.objectContaining({ name: "offset", schema: expect.objectContaining({ default: 0 }) }),
  );
  const components = doc.components!.schemas! as Record<
    string,
    { additionalProperties?: boolean; properties?: Record<string, unknown> }
  >;
  expect(components.ApprovalAuditEvent!.additionalProperties).toBe(false);
  expect(components.ApprovalAuditEvent!.properties).not.toHaveProperty("command");
  expect(components.ApprovalAuditRecord!.properties).toHaveProperty("recorded_at");
  expect(components.ApprovalAuditPage!.properties).not.toHaveProperty("next_after");
});
