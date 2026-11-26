import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBudgetTokenizerFixture } from "./fixtures/budget-tokenizer.js";
import { resolveStartupRetrievalBindings } from "../src/retrieval/startup-binding.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
const ready = { databaseConfigured: true, masterKey: TEST_MASTER_KEY };
const profile = { fusion: { mode: "rrf", threshold: 0.001 }, rerankerProvider: {} };
it.each([undefined, ""])("unset/empty %j keeps startup bindings absent", (raw) => {
  expect(resolveStartupRetrievalBindings(raw, { databaseConfigured: false })).toEqual({});
});
it.each([
  " ",
  "null",
  "false",
  "{}",
  "{bad",
  JSON.stringify({ ...profile, api_key: "private-sentinel" }),
  JSON.stringify({ ...profile, flagsSnapshot: {} }),
  JSON.stringify({ ...profile, rerankerProvider: { providerId: "bad" } }),
  JSON.stringify({ ...profile, fusion: { mode: "rrf", threshold: 0.1, maxCandidates: 201 } }),
  "x".repeat(8193),
])("invalid profile fails with fixed message without input %s", (raw) => {
  expect(() => resolveStartupRetrievalBindings(raw, ready)).toThrow(
    "MNEMIC_RETRIEVAL_BINDING_JSON invalid",
  );
});
it.each([
  { databaseConfigured: false, masterKey: TEST_MASTER_KEY },
  { databaseConfigured: true },
  { databaseConfigured: true, masterKey: Buffer.alloc(31) },
])("configured profile requires database and master key", (deps) => {
  expect(() => resolveStartupRetrievalBindings(JSON.stringify(profile), deps)).toThrow(
    "retrieval startup requires database and master key",
  );
});
it.each([
  profile,
  {
    fusion: {
      mode: "weighted",
      threshold: 0.1,
      weights: { vector: 0.7, keyword: 0.3, entity: 0, time: 0 },
    },
    rerankerProvider: {},
  },
])("valid %j installs both immutable bindings without touching flags", (config) => {
  const result = resolveStartupRetrievalBindings(JSON.stringify(config), ready);
  expect(result.recallBinding).toEqual(result.chatRetrievalBinding);
  expect(Object.keys(result).sort()).toEqual(["chatRetrievalBinding", "recallBinding"]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.recallBinding?.fusion)).toBe(true);
  expect(result).not.toHaveProperty("flagsSnapshot");
});
it("explicit chat replay installs a separate frozen chat capability without altering recall", () => {
  const result = resolveStartupRetrievalBindings(
    JSON.stringify({ ...profile, chatReadTimeResolution: true }),
    ready,
  );
  expect(result.chatRetrievalBinding).toMatchObject({
    readTimeResolution: true,
    fusion: profile.fusion,
  });
  expect(result.recallBinding).not.toHaveProperty("readTimeResolution");
  expect(result.chatRetrievalBinding).not.toBe(result.recallBinding);
  expect(Object.isFrozen(result.chatRetrievalBinding)).toBe(true);
  expect(Object.isFrozen(result.chatRetrievalBinding?.rerankerProvider)).toBe(true);
});
it.each([false, null, 0, "true"])(
  "rejects malformed chat replay startup option %j",
  (chatReadTimeResolution) => {
    expect(() =>
      resolveStartupRetrievalBindings(
        JSON.stringify({ ...profile, chatReadTimeResolution }),
        ready,
      ),
    ).toThrow("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
  },
);
it("chat replay still requires startup dependencies", () => {
  expect(() =>
    resolveStartupRetrievalBindings(JSON.stringify({ ...profile, chatReadTimeResolution: true }), {
      databaseConfigured: false,
    }),
  ).toThrow("retrieval startup requires database and master key");
});

it.each([false, true])("startup recall replay is independent of chat replay (%s)", (chatReplay) => {
  const result = resolveStartupRetrievalBindings(
    JSON.stringify({
      ...profile,
      recallReadTimeResolution: true,
      ...(chatReplay ? { chatReadTimeResolution: true } : {}),
    }),
    ready,
  );
  expect(result.recallBinding).toMatchObject({
    ...profile,
    readTimeResolution: true,
  });
  expect(Object.isFrozen(result.recallBinding)).toBe(true);
  expect(Object.isFrozen(result.recallBinding?.fusion)).toBe(true);
  expect(Object.isFrozen(result.recallBinding?.rerankerProvider)).toBe(true);
  if (chatReplay) expect(result.chatRetrievalBinding).toMatchObject({ readTimeResolution: true });
  else expect(result.chatRetrievalBinding).not.toHaveProperty("readTimeResolution");
});

it.each([false, null, 0, "true"])("rejects malformed recall replay startup option %j", (option) => {
  expect(() =>
    resolveStartupRetrievalBindings(
      JSON.stringify({ ...profile, recallReadTimeResolution: option }),
      ready,
    ),
  ).toThrow("MNEMIC_RETRIEVAL_BINDING_JSON invalid");
});

it("recall replay still requires startup dependencies", () => {
  expect(() =>
    resolveStartupRetrievalBindings(
      JSON.stringify({ ...profile, recallReadTimeResolution: true }),
      {
        databaseConfigured: false,
      },
    ),
  ).toThrow("retrieval startup requires database and master key");
});

it("loads a model-pinned local tokenizer for Chat and counts tokens without template additions", () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemic-tokenizer-"));
  try {
    const paths = writeBudgetTokenizerFixture(dir);
    const model = { providerId: "01920000-0000-7000-8000-00000000000a", modelId: "exact model" };
    const result = resolveStartupRetrievalBindings(
      JSON.stringify({
        ...profile,
        chatReadTimeResolution: true,
        chatMemoryBudget: { maxTokens: 16, ...model, ...paths },
      }),
      ready,
    );
    const chat = result.chatRetrievalBinding;
    expect(chat).toMatchObject({ memoryBudgetModel: model, readTimeResolution: true });
    expect(chat?.memoryBudget?.maxTokens).toBe(16);
    expect(Object.isFrozen(chat?.memoryBudget)).toBe(true);
    // The loaded tokenizer remains usable after the source files are removed.
    rmSync(dir, { recursive: true });
    expect(chat?.memoryBudget?.countTokens("hello 中文")).toBe(3);
    expect(chat?.memoryBudget?.countTokens("")).toBe(0);
    expect(result.recallBinding).not.toHaveProperty("memoryBudget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("requires database and key before loading local tokenizer files", () => {
  expect(() =>
    resolveStartupRetrievalBindings(
      JSON.stringify({
        ...profile,
        chatMemoryBudget: {
          maxTokens: 16,
          providerId: "01920000-0000-7000-8000-00000000000a",
          modelId: "offline",
          tokenizerFile: "/missing/private-tokenizer",
          tokenizerConfigFile: "/missing/private-config",
        },
      }),
      { databaseConfigured: false },
    ),
  ).toThrow("retrieval startup requires database and master key");
});

it.each([
  "remote",
  "directory",
  "oversize",
  "bad-json",
  "bad-artifact",
  "bad-pattern",
  "extra",
] as const)("rejects %s tokenizer configuration without exposing local details", (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), "mnemic-tokenizer-private-"));
  try {
    const paths = writeBudgetTokenizerFixture(dir);
    if (scenario === "oversize") truncateSync(paths.tokenizerConfigFile, 1024 * 1024 + 1);
    if (scenario === "bad-json") writeFileSync(paths.tokenizerConfigFile, "{private-sentinel");
    if (scenario === "bad-artifact") writeFileSync(paths.tokenizerFile, "{}");
    if (scenario === "bad-pattern") {
      const json = JSON.parse(readFileSync(paths.tokenizerFile, "utf8"));
      json.pre_tokenizer = {
        type: "Sequence",
        pretokenizers: [{ type: "Split", pattern: { unsupported: "offline-fixture" } }],
      };
      writeFileSync(paths.tokenizerFile, JSON.stringify(json));
    }
    const input = {
      ...profile,
      chatMemoryBudget: {
        ...paths,
        maxTokens: 16,
        providerId: "01920000-0000-7000-8000-00000000000a",
        modelId: "offline",
        ...(scenario === "remote"
          ? { tokenizerFile: "https://example.invalid/tokenizer.json" }
          : {}),
        ...(scenario === "directory" ? { tokenizerFile: dir } : {}),
        ...(scenario === "extra" ? { fallback: true } : {}),
      },
    };
    expect(() => resolveStartupRetrievalBindings(JSON.stringify(input), ready)).toThrow(
      /^MNEMIC_RETRIEVAL_BINDING_JSON invalid$/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
