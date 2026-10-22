import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { createApiClient } from "@mnemic/shared";
import { RecallResultSchema } from "@mnemic/shared/memory";
import { buildApp } from "../src/app.js";
import { retrieve } from "../src/retrieval/search.js";
import { indexBeliefVersion } from "../src/retrieval/embed.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory, bagOfWordsVector } from "./fixtures/bag-embedding.js";
import { MockEmbeddingModelV2 } from "ai/test";
import { runRecallCommand } from "../../cli/src/memory-commands.js";
import { parseChatInput } from "../../cli/src/slash-commands.js";

describe("explicit project recall HTTP (#32), real PG and offline embedding", () => {
  let t: TestDb;
  let app: ReturnType<typeof buildApp>;
  let project: string;
  let foreign: string;
  let api: ReturnType<typeof createApiClient>;
  const token = "recall-test-bearer-00000000000000000";
  const embedding = vi.fn(bagEmbeddingFactory.embeddingModel);
  const language = vi.fn(() => {
    throw new Error("must not call paid chat");
  });
  const factory = { embeddingModel: embedding, languageModel: language };
  const logs: string[] = [];
  const seed = async (p: string, value: string, indexed = false) => {
    const belief = uuidv7(),
      version = uuidv7();
    await t.sql`insert into beliefs (id, project_id, subject, attribute, salience) values (${belief}, ${p}, ${belief}, 'db', 0.5)`;
    await t.sql`insert into belief_versions (id, belief_id, value, valid_from, recorded_from) values (${version}, ${belief}, ${JSON.stringify(value)}, now(), now())`;
    await t.sql`update beliefs set current_version_id=${version} where id=${belief}`;
    if (indexed)
      await indexBeliefVersion(
        t.db,
        TEST_MASTER_KEY,
        { beliefVersionId: version, subject: belief, attribute: "db", value },
        { factory },
      );
    return { belief, version };
  };
  const post = (
    p = project,
    body: unknown = { query: "PostgreSQL" },
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/projects/${p}/recall`,
      payload: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    });
  beforeAll(async () => {
    t = await setupTestDb();
    await t.sql`delete from provider_configs`;
    await createProvider(t.db, TEST_MASTER_KEY, {
      name: "recall-offline",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      apiKey: "offline-key-secret",
      models: { embedding: "bag-1024" },
    });
    project = uuidv7();
    foreign = uuidv7();
    await t.sql`insert into projects (id,name) values (${project},'recall'), (${foreign},'foreign')`;
    for (let i = 0; i < 6; i++) await seed(project, "PostgreSQL", true);
    await seed(foreign, "PostgreSQL foreign-secret", true);
    embedding.mockClear();
    app = buildApp({
      db: t.db,
      masterKey: TEST_MASTER_KEY,
      authToken: token,
      providerFactory: factory,
      corsOrigin: "https://trusted-web.invalid",
      logStream: { write: (s) => logs.push(s) },
    });
    api = createApiClient({
      baseUrl: "http://fixture.local",
      token,
      timeoutMs: 10000,
      fetch: async (url, init) => {
        const r = await app.inject({
          method: (init?.method ?? "GET") as "GET" | "POST",
          url: new URL(String(url)).pathname,
          headers: Object.fromEntries(new Headers(init?.headers)),
          payload: init?.body as string,
        });
        return new Response(r.body, { status: r.statusCode });
      },
    });
  }, 180000);
  afterEach(() => {
    vi.unstubAllEnvs();
    embedding.mockClear();
    language.mockClear();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it("returns selected content and exact persisted score-only trace without altering provenance or strength", async () => {
    vi.stubEnv("MNEMIC_READ_REINFORCE", "1");
    const snapshot = async () =>
      t.sql`select id, salience, confidence, importance, evidence_count, status from beliefs where project_id=${project} order by id`;
    const before = await snapshot();
    const counts = async () =>
      t.sql`select (select count(*) from messages) as m, (select count(*) from observations) as o, (select count(*) from belief_versions) as v`;
    const provenance = await counts();
    const r = RecallResultSchema.parse(await api.recallBeliefs(project, "PostgreSQL"));
    expect(r.project_id).toBe(project);
    expect(r.abstained).toBe(false);
    expect(r.candidates).toHaveLength(5);
    expect(r.trace.candidate_count).toBe(6);
    expect(r.trace.candidates).toHaveLength(6);
    expect(r.trace.candidates.some((c) => c.reason === "below_topk")).toBe(true);
    expect(r.candidates.every((c) => c.value === "PostgreSQL")).toBe(true);
    const [trace] =
      await t.sql`select * from retrieval_traces where id=${r.trace.id} and project_id=${project}`;
    expect(trace!.candidates).toEqual(r.trace.candidates);
    expect(trace!.reinforce_enabled).toBe(false);
    expect(trace!.query_text).toBe("PostgreSQL");
    expect(r.trace.candidates.every((c) => !("value" in c))).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await counts()).toEqual(provenance);
    expect(language).not.toHaveBeenCalled();
    expect(embedding).toHaveBeenCalledOnce();
    const http = await post();
    expect(http.headers["cache-control"]).toBe("no-store");
    expect(logs.join("")).not.toContain(token);
    expect(logs.join("")).not.toContain("offline-key-secret");
    const parsed = parseChatInput("/recall PostgreSQL");
    if (parsed.kind !== "command" || parsed.name !== "recall") throw new Error("bad CLI fixture");
    const text = await runRecallCommand(api, project, parsed.query);
    expect(text).toContain(`向量=${r.trace.candidates[0]!.vectorScore!.toFixed(4)}`);
    expect(text).toContain("关键词=1.0000");
    expect(text).toContain(`融合=${r.trace.candidates[0]!.fusedScore.toFixed(4)}`);
    expect(text).not.toContain("foreign-secret");
  });

  it("validates auth, project, body, Origin and JSON before any embedding or trace", async () => {
    const before = (
      await t.sql`select count(*) as n from retrieval_traces where project_id=${project}`
    )[0]!.n;
    const requests = [
      [post(project, { query: "PostgreSQL" }, { authorization: "Bearer wrong" }), 401],
      [post("not-uuid"), 400],
      [post(uuidv7()), 404],
      [post(project, { query: " " }), 400],
      [post(project, { query: "x".repeat(1001) }), 400],
      [post(project, { query: "db", reinforce: true }), 400],
      [post(project, { query: "db" }, { origin: "https://trusted-web.invalid" }), 403],
      [post(project, { query: "db" }, { "content-type": "text/plain" }), 415],
      [
        app.inject({
          method: "GET",
          url: `/projects/${project}/recall`,
          headers: { authorization: `Bearer ${token}` },
        }),
        404,
      ],
    ] as const;
    for (const [response, status] of requests) {
      const res = await response;
      expect(res.statusCode).toBe(status);
      expect(res.headers["content-type"]).toContain("application/problem+json");
    }
    expect(embedding).not.toHaveBeenCalled();
    expect(
      (await t.sql`select count(*) as n from retrieval_traces where project_id=${project}`)[0]!.n,
    ).toBe(before);
  });

  it("abstains in an empty project and excludes soft-deleted content", async () => {
    const empty = uuidv7();
    await t.sql`insert into projects (id,name) values (${empty},'empty')`;
    const r = RecallResultSchema.parse(await api.recallBeliefs(empty, "PostgreSQL"));
    expect(r.abstained).toBe(true);
    expect(r.candidates).toEqual([]);
    expect(r.trace.candidates).toEqual([]);
    const deleted = await seed(empty, "PostgreSQL", true);
    await t.sql`update beliefs set status='deleted' where id=${deleted.belief}`;
    expect(
      RecallResultSchema.parse(await api.recallBeliefs(empty, "PostgreSQL")).candidates,
    ).toEqual([]);
  });

  it("does not follow a current-version pointer into another belief/project", async () => {
    const bad = await seed(project, "innocent");
    const secret = await seed(foreign, "uniquesecretpointer");
    await t.sql`update beliefs set current_version_id=${secret.version} where id=${bad.belief}`;
    const result = await retrieve(t.db, TEST_MASTER_KEY, project, "uniquesecretpointer", {
      factory: {
        ...factory,
        embeddingModel: () => {
          throw new Error("keyword only");
        },
      },
      reinforce: false,
    });
    expect(result.candidates).toEqual([]);
  });

  it("bounds HTTP trace display to 200 while retaining the complete persisted trace", async () => {
    const p = uuidv7();
    await t.sql`insert into projects (id,name) values (${p},'bounded')`;
    for (let i = 0; i < 201; i++) await seed(p, "traceboundquery");
    const r = RecallResultSchema.parse(await api.recallBeliefs(p, "traceboundquery"));
    expect(r.candidates).toHaveLength(5);
    expect(r.trace.candidates).toHaveLength(200);
    expect(r.trace.candidate_count).toBe(201);
    expect(r.trace.truncated).toBe(true);
    expect(
      (
        await t.sql`select jsonb_array_length(candidates) as n from retrieval_traces where id=${r.trace.id}`
      )[0]!.n,
    ).toBe(201);
  });

  it("falls back to keyword scores when embedding is unavailable", async () => {
    embedding.mockImplementationOnce(() => {
      throw new Error("offline-upstream-private-secret");
    });
    const r = RecallResultSchema.parse(await api.recallBeliefs(project, "PostgreSQL"));
    expect(r.abstained).toBe(false);
    expect(r.trace.candidates.every((c) => c.vectorScore === null && c.keywordScore === 1)).toBe(
      true,
    );
    expect(logs.join("")).not.toContain("offline-upstream-private-secret");
    expect(embedding).toHaveBeenCalledOnce();
    expect(language).not.toHaveBeenCalled();
  });

  it("normalizes keyword ranks within the active current-project pool only", async () => {
    const p = uuidv7(),
      q = `isolation${uuidv7().replaceAll("-", "")}`;
    await t.sql`insert into projects (id,name) values (${p},'rank')`;
    await seed(p, q);
    const opts = {
      factory: {
        ...factory,
        embeddingModel: () => {
          throw new Error("keyword only");
        },
      },
      reinforce: false,
    };
    const before = await retrieve(t.db, TEST_MASTER_KEY, p, q, opts);
    await seed(foreign, Array(50).fill(q).join(" "));
    const after = await retrieve(t.db, TEST_MASTER_KEY, p, q, opts);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.candidates[0]!.keywordScore).toBe(1);
  });

  it("deduplicates repeated embeddings for the same version using the best finite score", async () => {
    const p = uuidv7();
    await t.sql`insert into projects(id,name) values (${p},'duplicates')`;
    const b = await seed(p, "PostgreSQL", true);
    await indexBeliefVersion(
      t.db,
      TEST_MASTER_KEY,
      { beliefVersionId: b.version, subject: b.belief, attribute: "db", value: "PostgreSQL" },
      { factory },
    );
    // 索引文本含 UUID subject，原向量分小于 1；新增精确查询向量保护 max 而非 min/avg。
    await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values (${uuidv7()},${b.version},${JSON.stringify(bagOfWordsVector("PostgreSQL"))}::vector,'offline')`;
    const r = RecallResultSchema.parse(await api.recallBeliefs(p, "PostgreSQL"));
    expect(r.candidates).toHaveLength(1);
    expect(r.trace.candidate_count).toBe(1);
    expect(r.trace.candidates[0]!.beliefVersionId).toBe(b.version);
    expect(Number.isFinite(r.trace.candidates[0]!.fusedScore)).toBe(true);
    expect(r.trace.candidates[0]!.vectorScore).toBeCloseTo(1, 5);
  });

  it.each(["!!!???", "PostgreSQL"])(
    "zero query vector degrades to keyword for %s without NaN",
    async (query) => {
      embedding.mockReturnValueOnce(
        new MockEmbeddingModelV2({
          doEmbed: async ({ values }) => ({ embeddings: values.map(() => Array(1024).fill(0)) }),
        }),
      );
      const r = RecallResultSchema.parse(await api.recallBeliefs(project, query));
      expect(r.abstained).toBe(query === "!!!???");
      expect(
        r.trace.candidates.every((c) => c.vectorScore === null && Number.isFinite(c.fusedScore)),
      ).toBe(true);
    },
  );

  it("stored zero embeddings cannot mask a valid score or poison keyword-only candidates", async () => {
    const p = uuidv7();
    await t.sql`insert into projects(id,name) values (${p},'stored-zero')`;
    const valid = await seed(p, "PostgreSQL", true);
    const zeroOnly = await seed(p, "PostgreSQL");
    for (const version of [valid.version, zeroOnly.version])
      await t.sql`insert into memory_embeddings(id,belief_version_id,embedding,model) values (${uuidv7()},${version},${JSON.stringify(Array(1024).fill(0))}::vector,'offline')`;
    const r = RecallResultSchema.parse(await api.recallBeliefs(p, "PostgreSQL"));
    expect(r.candidates).toHaveLength(2);
    const good = r.candidates.find((c) => c.beliefVersionId === valid.version)!;
    const kw = r.candidates.find((c) => c.beliefVersionId === zeroOnly.version)!;
    expect(Number.isFinite(good.vectorScore)).toBe(true);
    expect(kw.vectorScore).toBeNull();
    expect(kw.keywordScore).toBe(1);
    const [trace] = await t.sql`select candidates from retrieval_traces where id=${r.trace.id}`;
    expect(trace!.candidates).toEqual(r.trace.candidates);
  });
});
