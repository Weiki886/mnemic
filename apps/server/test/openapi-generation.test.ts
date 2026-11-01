import { expect, it } from "vitest";
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
    "/projects/{projectId}/beliefs",
    "/projects/{projectId}/beliefs/{id}",
    "/projects/{projectId}/beliefs/{id}/correct",
    "/projects/{projectId}/beliefs/{id}/delete",
    "/projects/{projectId}/beliefs/{id}/resolutions",
    "/projects/{projectId}/beliefs/{id}/restore",
    "/v1/config/flags",
  ]);
  expect(Object.keys(a.paths["/health"]!).sort()).toEqual(["get", "head"]);
  expect(Object.keys(a.paths["/v1/config/flags"]!).sort()).toEqual(["get", "put"]);
  expect(a.security).toEqual([{ bearerAuth: [] }]);
  expect(a.paths["/health"]!.get!.security).toEqual([]);
  expect(a.components?.securitySchemes?.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
  expect(JSON.stringify(a)).not.toMatch(/sk-|api_key|MASTER_KEY|\.env/);
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
