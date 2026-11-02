import { expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import {
  CreateProviderSchema,
  ProviderIdParamsSchema,
  ProviderProjectParamsSchema,
  StatusQuerySchema,
  ConfigQuerySchema,
  LegacyProviderViewSchema,
} from "../src/contracts/providers.js";
const body = {
  name: " fixture ",
  protocol: "openai-compatible",
  base_url: "https://example.invalid/v1",
  api_key: "offline-key-example",
  models: { chat: " unchanged " },
};
it("legacy create preserves whitespace and strips extras at both object levels", () => {
  expect(
    CreateProviderSchema.parse({ ...body, extra: true, models: { ...body.models, extra: true } }),
  ).toEqual(body);
});
it.each([
  { ...body, models: {} },
  { ...body, api_key: "short" },
  { ...body, protocol: "other" },
])("legacy create rejects missing slots or invalid fields", (value) => {
  expect(CreateProviderSchema.safeParse(value).success).toBe(false);
});
it("UUID and strict read queries preserve existing rules", () => {
  expect(ProviderIdParamsSchema.safeParse({ id: "bad" }).success).toBe(false);
  expect(ProviderProjectParamsSchema.safeParse({ projectId: "bad" }).success).toBe(false);
  expect(StatusQuerySchema.parse({ conversation_id: uuidv7() })).toHaveProperty("conversation_id");
  expect(StatusQuerySchema.safeParse({ conversation_id: uuidv7(), extra: true }).success).toBe(
    false,
  );
  expect(ConfigQuerySchema.parse({})).toEqual({});
  expect(ConfigQuerySchema.safeParse({ extra: true }).success).toBe(false);
});
it("legacy masked output requires explicit raw models and excludes raw credential fields", () => {
  const row = {
    id: uuidv7(),
    name: "p",
    protocol: "anthropic",
    baseUrl: "https://example.invalid",
    apiKeyMasked: "••••1234",
    models: null,
    createdAt: "2026-11-02T00:00:00Z",
  };
  expect(LegacyProviderViewSchema.safeParse(row).success).toBe(true);
  const { models: _models, ...missing } = row;
  expect(LegacyProviderViewSchema.safeParse(missing).success).toBe(false);
  expect(LegacyProviderViewSchema.safeParse({ ...row, apiKey: "forbidden" }).success).toBe(false);
});
