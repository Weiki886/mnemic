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
  expect(Object.keys(a.paths).sort()).toEqual(["/health", "/v1/config/flags"]);
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
    ajv = new Ajv({ strict: false, allErrors: true });
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
