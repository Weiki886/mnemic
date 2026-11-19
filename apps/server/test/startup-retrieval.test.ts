import { expect, it } from "vitest";
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
