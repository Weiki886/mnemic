import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { createApiClient } from "@mnemic/shared";
import { parseChatInput } from "../../cli/src/slash-commands.js";
import { runMemoryCommand } from "../../cli/src/memory-commands.js";
import { buildApp } from "../src/app.js";
import { ingestCandidate } from "../src/ingest/ingest.js";
import { retrieve } from "../src/retrieval/search.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";

describe("CLI memory/forget ↔ Web API (#32), real PostgreSQL", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let project: string;
  let other: string;
  let target: string;
  let api: ReturnType<typeof createApiClient>;
  const token = "memory-cli-fixture-token-0000000000";
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const res = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    return new Response(res.body, { status: res.statusCode });
  };
  const command = async (text: string, projectId = project) => {
    const parsed = parseChatInput(text);
    if (parsed.kind !== "command" || (parsed.name !== "memory" && parsed.name !== "forget"))
      throw new Error("bad fixture command");
    return runMemoryCommand(api, projectId, parsed);
  };
  beforeAll(async () => {
    t = await setupTestDb();
    project = uuidv7();
    other = uuidv7();
    await t.sql`insert into projects (id, name) values (${project}, 'cli-memory'), (${other}, 'cli-memory-other')`;
    const conv = uuidv7();
    await t.sql`insert into conversations (id, project_id) values (${conv}, ${project})`;
    for (const [subject, value] of [
      ["alpha-database", "PostgreSQL"],
      ["beta-database", "SQLite"],
    ]) {
      const message = uuidv7();
      await t.sql`insert into messages (id, conversation_id, speaker, raw_text, msg_time) values (${message}, ${conv}, 'user', ${value!}, now())`;
      const result = await ingestCandidate(
        t.db,
        project,
        {
          type: "decision",
          subject: subject!,
          attribute: "engine",
          value: value!,
          valid_time: "2026-10-01",
          time_precision: "DAY",
          time_confidence: 1,
          assertion_intent: "ASSERT",
          source_type: "USER_EXPLICIT",
          authority: 60,
          reliability: 0.9,
          confidence: 0.9,
          importance: 0.8,
          entities: [],
          is_profile: false,
        },
        message,
      );
      if (subject === "alpha-database") target = result.beliefId!;
    }
    app = buildApp({
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      authToken: token,
      providerFactory: bagEmbeddingFactory,
    });
    api = createApiClient({
      baseUrl: "http://fixture.local",
      token,
      fetch: transport,
      timeoutMs: 10000,
    });
  }, 180000);
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it("CLI list matches Web, forget exits retrieval without altering Evidence/version chain, Web restore is reflected", async () => {
    const web = await api.listBeliefs(project, {
      type: "decision",
      q: "database",
      limit: 1,
      offset: 0,
    });
    expect(web).toHaveLength(1);
    expect(web[0]!.id).toBe(target);
    const text = await command("/memory --type decision --limit 1 database");
    expect(text).toContain(web[0]!.id);
    expect(text).toContain("PostgreSQL");
    const provenance = async () => t.sql`select
      (select count(*) from observations where project_id = ${project}) as observations,
      (select count(*) from messages m join conversations c on c.id=m.conversation_id where c.project_id = ${project}) as messages,
      (select count(*) from belief_versions v join beliefs b on b.id=v.belief_id where b.project_id = ${project}) as versions`;
    const before = await provenance();
    const recall = () =>
      retrieve(t.db, TEST_MASTER_KEY, project, "PostgreSQL", {
        factory: bagEmbeddingFactory,
        threshold: 0.1,
        reinforce: false,
      });
    expect((await recall()).candidates.map((c) => c.beliefId)).toContain(target);
    expect(await command(`/forget ${target.toUpperCase()}`)).toContain("软删除已确认");
    expect((await api.getBelief(project, target)).status).toBe("deleted");
    expect((await api.listBeliefs(project)).map((row) => row.id)).not.toContain(target);
    expect((await api.listBeliefs(project, { status: "deleted" })).map((row) => row.id)).toContain(
      target,
    );
    expect((await recall()).candidates.map((c) => c.beliefId)).not.toContain(target);
    expect(await provenance()).toEqual(before);
    expect(await command("/memory --status deleted --type decision")).toContain(target);
    await expect(command(`/forget ${target}`)).rejects.toThrow("记忆状态冲突");
    await api.restoreBelief(project, target);
    expect(await command("/memory")).toContain(target);
  });

  it("cross-project delete is 404, missing bearer is rejected, state remains active", async () => {
    await expect(command(`/forget ${target}`, other)).rejects.toThrow("记忆不存在");
    const unauthenticated = createApiClient({ baseUrl: "http://fixture.local", fetch: transport });
    const parsed = parseChatInput(`/forget ${target}`);
    if (parsed.kind !== "command" || parsed.name !== "forget")
      throw new Error("bad fixture command");
    await expect(runMemoryCommand(unauthenticated, project, parsed)).rejects.toThrow(
      "MNEMIC_AUTH_TOKEN",
    );
    expect((await api.getBelief(project, target)).status).toBe("active");
  });
});
