import { expect, it } from "vitest";
import {
  ProviderRerankerConfigSchema,
  ProviderRerankerStateSchema,
  ProviderRerankerCreateSchema,
  ProviderRerankerUpdateSchema,
} from "../src/management.js";
const config = { endpoint_path: "/score", timeout_ms: 5000 };
it("accepts canonical independent capabilities and explicit disabled states", () => {
  expect(ProviderRerankerConfigSchema.parse(config)).toEqual(config);
  expect(ProviderRerankerStateSchema.parse({ revision: 0, config: null })).toEqual({
    revision: 0,
    config: null,
  });
  expect(ProviderRerankerUpdateSchema.parse({ expected_revision: 1, config })).toEqual({
    expected_revision: 1,
    config,
  });
});
it.each([
  "//evil.test/score",
  "https://evil.test/score",
  "/../score",
  "/%2fscore",
  "/score?key=secret",
  "/score#frag",
  "/score\n",
  "/score\\x",
  "/x.json/score",
])("rejects noncanonical path %j", (endpoint_path) => {
  expect(ProviderRerankerConfigSchema.safeParse({ ...config, endpoint_path }).success).toBe(false);
});
it.each([
  { timeout_ms: 0 },
  { timeout_ms: 30001 },
  { timeout_ms: 1.5 },
  { api_key: "secret" },
  { model: "other" },
  { endpoint_path: "/x" },
])("rejects malformed/credential-bearing capabilities %j", (extra) => {
  expect(ProviderRerankerConfigSchema.safeParse({ ...config, ...extra }).success).toBe(false);
});
it("requires full bounded revision/config states and rejects credential replacement through PUT", () => {
  for (const value of [
    { revision: -1, config: null },
    { revision: 1.5, config: null },
    { revision: Number.MAX_SAFE_INTEGER + 1, config: null },
    { revision: 0 },
    { revision: 0, config, extra: true },
  ])
    expect(ProviderRerankerStateSchema.safeParse(value).success).toBe(false);
  expect(
    ProviderRerankerUpdateSchema.safeParse({ expected_revision: 0, config, api_key: "secret" })
      .success,
  ).toBe(false);
});
it("score-only creation has no model slot fields and copies the caller payload", () => {
  const body = {
    name: " offline ",
    base_url: "https://example.invalid/v1",
    api_key: "offline-key-0000",
    config,
  };
  const copy = ProviderRerankerCreateSchema.parse(body);
  body.config.timeout_ms = 1;
  expect(copy.name).toBe("offline");
  expect(copy.config.timeout_ms).toBe(5000);
  expect(
    ProviderRerankerCreateSchema.safeParse({ ...copy, models: { reranker: "other" } }).success,
  ).toBe(false);
});

it("new Score-only registration bounds the original Provider URL, not just the derived path", () => {
  expect(
    ProviderRerankerCreateSchema.safeParse({
      name: "offline",
      base_url: "https://example.invalid/" + "x".repeat(2048),
      api_key: "offline-key-0000",
      config: { endpoint_path: "/score", timeout_ms: 5000 },
    }).success,
  ).toBe(false);
});

it.each([
  "https://off\nline.invalid/v1",
  " https://offline.invalid/v1 ",
  "https://offline.invalid/\ud800",
])("new registration rejects raw URL normalization traps %j", (base_url) => {
  expect(
    ProviderRerankerCreateSchema.safeParse({
      name: "offline",
      base_url,
      api_key: "offline-key-0000",
      config: { endpoint_path: "/score", timeout_ms: 5000 },
    }).success,
  ).toBe(false);
});
