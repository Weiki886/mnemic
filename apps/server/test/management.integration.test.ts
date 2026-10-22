import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { createApiClient } from "@mnemic/shared";
import { ConfigSchema, ProjectStatusSchema } from "@mnemic/shared/management";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { resolveModel } from "../src/providers/slots.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { MockLanguageModelV2 } from "ai/test";
import { DbResolutionTraceWriter } from "../src/resolver/trace-writer.js";
import { runManagementCommand } from "../../cli/src/management-commands.js";

describe("status/config share server single source (#32)", () => {
  let t: TestDb, app: ReturnType<typeof buildApp>, api: ReturnType<typeof createApiClient>;
  let project: string,
    other: string,
    conversation: string,
    foreignConversation: string,
    provider: string,
    embedding: string;
  const token = "management-fixture-bearer-0000000000";
  const logs: string[] = [];
  const language = vi.fn(() => new MockLanguageModelV2());
  const vector = vi.fn(() => {
    throw new Error("must not probe");
  });
  const patch = (id: string, payload: unknown, authorization = `Bearer ${token}`) =>
    app.inject({
      method: "PATCH",
      url: `/providers/${id}`,
      headers: { authorization, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  beforeAll(async () => {
    t = await setupTestDb();
    await t.sql`delete from provider_configs`;
    const p = await createProvider(t.db, TEST_MASTER_KEY, {
      name: "managed",
      protocol: "openai-compatible",
      baseUrl: "https://host.invalid/v1",
      apiKey: "fake-key-sensitive-1234",
      models: { chat: "old-chat", extraction: "old-extraction" },
    });
    provider = p.id;
    embedding = (
      await createProvider(t.db, TEST_MASTER_KEY, {
        name: "embedding",
        protocol: "openai-compatible",
        baseUrl: "https://embedding.invalid",
        apiKey: "fake-key-other-5678",
        models: { embedding: "old-embedding" },
      })
    ).id;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "legacy",
      protocol: "openai-compatible",
      baseUrl: "https://user:password@legacy.invalid/v1?key=query-secret#fragment-secret",
      apiKey: "fake-key-third-9876",
      models: { chat: "later" },
    });
    project = uuidv7();
    other = uuidv7();
    conversation = uuidv7();
    foreignConversation = uuidv7();
    await t.sql`insert into projects(id,name) values (${project},'own'),(${other},'other')`;
    await t.sql`insert into conversations(id,project_id) values (${conversation},${project}),(${foreignConversation},${other})`;
    for (const status of ["active", "deleted"])
      await t.sql`insert into beliefs(id,project_id,subject,attribute,status) values (${uuidv7()},${project},${status},'x',${status})`;
    await t.sql`insert into beliefs(id,project_id,subject,attribute) values (${uuidv7()},${other},'secret-foreign','x')`;
    app = buildApp({
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      authToken: token,
      providerFactory: { languageModel: language, embeddingModel: vector },
      logStream: { write: (s) => logs.push(s) },
    });
    api = createApiClient({
      baseUrl: "http://fixture",
      token,
      fetch: async (url, init) => {
        const u = new URL(String(url));
        const r = await app.inject({
          method: (init?.method ?? "GET") as "GET" | "PATCH",
          url: u.pathname + u.search,
          headers: Object.fromEntries(new Headers(init?.headers)),
          ...(typeof init?.body === "string" ? { payload: init.body } : {}),
        });
        return new Response(r.body, { status: r.statusCode });
      },
    });
  }, 180000);
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it("returns scoped exact counts/current session and effective slots without decrypting or probing", async () => {
    const status = ProjectStatusSchema.parse(await api.getProjectStatus(project, conversation));
    expect(status.project).toEqual({ id: project, name: "own" });
    expect(status.conversation.id).toBe(conversation);
    expect(status.counts).toEqual({
      total: 2,
      active: 1,
      deleted: 1,
      retracted: 0,
      superseded: 0,
      expired: 0,
    });
    expect(status.slots.chat?.provider_id).toBe(provider);
    expect(status.slots.chat?.model).toBe("old-chat");
    expect(
      await runManagementCommand(api, project, conversation, { kind: "command", name: "status" }),
    ).toContain("active=1");
    expect(language).not.toHaveBeenCalled();
    expect(vector).not.toHaveBeenCalled();
  });
  it("rejects foreign sessions, invalid UUID/query and missing bearer", async () => {
    for (const [url, status] of [
      [`/projects/${project}/status?conversation_id=${foreignConversation}`, 404],
      [`/projects/${other}/status?conversation_id=${conversation}`, 404],
      [`/projects/not-uuid/status?conversation_id=${conversation}`, 400],
      [`/projects/${project}/status`, 400],
      ["/v1/config?probe=1", 400],
    ] as const) {
      const r = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.statusCode).toBe(status);
    }
    expect((await app.inject({ method: "GET", url: "/v1/config" })).statusCode).toBe(401);
  });
  it("safe config projection never includes keys or credential-bearing URL parts", async () => {
    const config = ConfigSchema.parse(await api.getConfig());
    expect(config.providers).toHaveLength(3);
    expect(config.slots.embedding?.provider_id).toBe(embedding);
    expect(config.providers.find((p) => p.name === "legacy")?.base_url).toBe(
      "https://legacy.invalid/v1",
    );
    const serialized = JSON.stringify(config);
    for (const secret of [
      "apiKey",
      "api_key",
      "fake-key",
      "password",
      "query-secret",
      "fragment-secret",
    ])
      expect(serialized).not.toContain(secret);
    expect(language).not.toHaveBeenCalled();
    expect(vector).not.toHaveBeenCalled();
  });
  it("patches existing metadata and merges disjoint model updates atomically without rotating key", async () => {
    const [before] =
      await t.sql`select api_key_encrypted from provider_configs where id=${provider}`;
    await api.updateProvider(provider, {
      name: "managed-new",
      base_url: "https://new.invalid/v1",
      protocol: "anthropic",
    });
    await Promise.all([
      api.updateProvider(provider, { models: { chat: "new-chat" } }),
      api.updateProvider(provider, { models: { extraction: "new-extraction" } }),
    ]);
    const [after] = await t.sql`select * from provider_configs where id=${provider}`;
    expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted);
    expect(after!.models).toEqual({ chat: "new-chat", extraction: "new-extraction" });
    const config = ConfigSchema.parse(await api.getConfig());
    expect(config.slots.chat?.model).toBe("new-chat");
    expect((await api.getProjectStatus(project, conversation)).slots.chat?.provider_name).toBe(
      "managed-new",
    );
    expect(language).not.toHaveBeenCalled();
    expect(vector).not.toHaveBeenCalled();
    const resolved = await resolveModel(t.db, TEST_MASTER_KEY, "chat", {
      factory: { languageModel: language, embeddingModel: vector },
    });
    expect(resolved.modelId).toBe("new-chat");
    expect(resolved.providerName).toBe("managed-new");
    expect(logs.join("")).not.toContain("fake-key-sensitive-1234");
    expect(logs.join("")).not.toContain(token);
  });
  it("rejects invalid/global unsafe changes, preserves state and protects embedding REEMBED boundary", async () => {
    const before = await t.sql`select * from provider_configs order by id`;
    for (const [id, body, status] of [
      [provider, {}, 400],
      [provider, { api_key: "never-store-in-chat" }, 400],
      [provider, { models: { embedding: "other" } }, 400],
      [provider, { base_url: "https://user:pass@host.invalid" }, 400],
      [provider, { base_url: "not a url" }, 400],
      ["bad", { name: "x" }, 400],
      [uuidv7(), { name: "x" }, 404],
      [provider, { name: "embedding" }, 409],
      [embedding, { base_url: "https://other.invalid" }, 409],
      [embedding, { protocol: "anthropic" }, 409],
    ] as const) {
      const r = await patch(id, body);
      expect(r.statusCode).toBe(status);
      expect(r.headers["content-type"]).toContain("application/problem+json");
    }
    expect((await patch(provider, { name: "wrong" }, "Bearer wrong")).statusCode).toBe(401);
    expect(await t.sql`select * from provider_configs order by id`).toEqual(before);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/config",
          headers: { authorization: `Bearer ${token}` },
        })
      ).headers["cache-control"],
    ).toBe("no-store");
  });
  it("uses the same deterministic tied-provider choice in status, SDK and persisted resolution snapshot", async () => {
    const low = "00000000-0000-7000-8000-000000000001";
    const tie = await createProvider(t.db, TEST_MASTER_KEY, {
      name: "tie",
      protocol: "openai-compatible",
      baseUrl: "https://tie.invalid",
      apiKey: "fake-key-tie-0000",
      models: { extraction: "tie-model" },
    });
    await t.sql`update provider_configs set id=${low} where id=${tie.id}`;
    await t.sql`update provider_configs set created_at='2020-01-01T00:00:00Z'`;
    expect((await api.getConfig()).slots.extraction?.provider_id).toBe(low);
    expect(
      (
        await resolveModel(t.db, TEST_MASTER_KEY, "extraction", {
          factory: { languageModel: language, embeddingModel: vector },
        })
      ).modelId,
    ).toBe("tie-model");
    const msg = uuidv7(),
      obs = uuidv7();
    await t.sql`insert into messages(id,conversation_id,speaker,raw_text,msg_time) values (${msg},${conversation},'user','fixture',now())`;
    await t.sql`insert into observations(id,project_id,type,subject,attribute,value,assertion_intent,source_type,authority,evidence_id) values (${obs},${project},'fact','p','a','"v"','ASSERT','USER_EXPLICIT',60,${msg})`;
    const belief = (await t.sql`select id from beliefs where project_id=${project} limit 1`)[0]!.id;
    await new DbResolutionTraceWriter(t.db).write({
      projectId: project,
      beliefId: belief,
      observationId: obs,
      relation: "strengthen",
      confidenceBefore: 0.5,
      confidenceAfter: 0.6,
      policies: {},
      previousVersionId: null,
      resultVersionId: null,
      resolverVersion: "fixture",
    });
    expect(
      (await t.sql`select model_snapshot from resolution_traces where observation_id=${obs}`)[0]!
        .model_snapshot,
    ).toMatchObject({ provider: "tie", model: "tie-model" });
  });
});
