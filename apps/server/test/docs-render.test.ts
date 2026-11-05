import { expect, it } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderDocumentation, loadDocumentation } from "../src/docs/render.js";
const artifact = new URL("../../../docs/openapi.json", import.meta.url);
it("renders every checked operation, field contract and named schema without fetching a service", async () => {
  const text = await readFile(artifact, "utf8"),
    doc = JSON.parse(text);
  const html = renderDocumentation(doc);
  expect(html).toContain("<!doctype html>");
  expect(html).toContain('lang="zh-CN"');
  for (const item of Object.values(doc.paths) as Record<string, { operationId: string }>[])
    for (const op of Object.values(item))
      expect(html).toContain(`id="op-${encodeURIComponent(op.operationId)}"`);
  for (const name of Object.keys(doc.components.schemas))
    expect(html).toContain(`id="schema-${encodeURIComponent(name)}"`);
  expect(html).toContain("Apache License 2.0");
  expect(html).toContain("securitySchemes");
  expect(html).toContain("bearerAuth");
  expect(html).toContain("&quot;scheme&quot;: &quot;bearer&quot;");
  expect(html).toContain("http://127.0.0.1:3000");
  expect(html).toContain("x-sse-event-schema");
  expect(html).toContain("requestBody");
  expect(html).toContain("只读");
  expect(html).toContain('href="docs/openapi.json"');
  expect(html).not.toMatch(/<script|<iframe|<form|<input|\son\w+=/i);
  expect(html).not.toMatch(/(?:src|href)="https?:/i);
  expect(JSON.stringify(doc)).toBe(JSON.stringify(JSON.parse(text)));
});
it("escapes hostile text and attributes and never turns arbitrary URLs into executable links", () => {
  const attack = '"><script>alert(1)</script><img src=x onerror=alert(1)>';
  const html = renderDocumentation({
    openapi: "3.0.3",
    info: { title: attack, version: "x" },
    paths: {
      [attack]: {
        get: {
          operationId: attack,
          tags: [attack],
          summary: attack,
          description: attack,
          responses: {
            200: {
              description: attack,
              content: { "application/json": { schema: { $ref: "javascript:alert(1)" } } },
            },
          },
        },
      },
    },
    components: { schemas: { [attack]: { example: attack } } },
  });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&quot;");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain(`id="op-${encodeURIComponent(attack)}"`);
});
it("loads exact checked JSON bytes and derives the page from that same immutable snapshot", async () => {
  const result = await loadDocumentation(artifact);
  expect(result.json).toBe(await readFile(artifact, "utf8"));
  expect(result.html).toBe(renderDocumentation(JSON.parse(result.json)));
});
it("missing, malformed and incompatible artifacts fail with one fixed error without filesystem details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mnemic-docs-test-")),
    file = pathToFileURL(join(dir, "bad.json"));
  try {
    await expect(loadDocumentation(file)).rejects.toThrow(/^Documentation artifact unavailable$/);
    for (const value of [
      "{broken",
      "null",
      JSON.stringify({ openapi: "2.0", info: {}, paths: {} }),
    ]) {
      await writeFile(file, value);
      await expect(loadDocumentation(file)).rejects.toThrow(/^Documentation artifact unavailable$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
