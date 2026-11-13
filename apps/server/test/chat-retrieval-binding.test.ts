import { expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { TEST_MASTER_KEY } from "./test-keys.js";
const db = new Proxy(
  {},
  {
    get() {
      throw Error("database touched");
    },
  },
);
const valid = { fusion: { mode: "rrf", threshold: 0.001 }, rerankerProvider: {} };
it.each([
  null,
  false,
  {},
  { ...valid, apiKey: "offline-private" },
  { ...valid, flagsSnapshot: {} },
  { ...valid, rerankerProvider: { api_key: "offline-private" } },
  { ...valid, rerankerProvider: { providerId: "not-a-uuid" } },
  { ...valid, fusion: { mode: "rrf" } },
  { ...valid, fusion: { mode: "rrf", threshold: 0.001, maxCandidates: 201 } },
])("invalid trusted chat retrieval binding %j fails before app startup", async (binding) => {
  let app: FastifyInstance | undefined;
  try {
    expect(() => {
      app = buildApp({ auth: false, chatRetrievalBinding: binding } as never);
    }).toThrow("INVALID_RECALL_BINDING");
  } finally {
    await app?.close();
  }
});
it.each([
  {},
  { modelDailyCallLimit: 10 },
  { db, modelDailyCallLimit: 10 },
  { db, masterKey: TEST_MASTER_KEY },
  { db, masterKey: Buffer.alloc(31), modelDailyCallLimit: 10 },
])("a binding cannot register without database, key and persisted admission", async (extra) => {
  let app: FastifyInstance | undefined;
  try {
    expect(() => {
      app = buildApp({ auth: false, ...extra, chatRetrievalBinding: valid } as never);
    }).toThrow("chat retrieval binding requires database, master key and daily quota");
  } finally {
    await app?.close();
  }
});
