import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModel } from "ai";
import { buildApp } from "../src/app.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";
const run = promisify(execFile),
  path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  calls = 0;
const prompts: unknown[] = [];
const token = "offline-pty-stream-test-token-000000";
const project = uuidv7(),
  belief = uuidv7(),
  version = uuidv7();
beforeAll(async () => {
  t = await setupTestDb();
  await t.sql`delete from provider_configs`;
  await t.sql`insert into projects (id,name) values (${project},'CLI PTY')`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "offline-pty",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { chat: "chat", extraction: "extract", embedding: "bag" },
  });
  const factory = {
    ...bagEmbeddingFactory,
    languageModel: () =>
      new MockLanguageModelV2({
        doGenerate: async () => ({
          content: [{ type: "text", text: "[]" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }),
        doStream: async (opts) => {
          calls++;
          prompts.push(opts.prompt);
          const n = calls;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "text" });
                controller.enqueue({
                  type: "text-delta",
                  id: "text",
                  delta: n < 3 ? `PTY partial ${n}` : "PTY completed",
                });
                if (n === 3) {
                  controller.enqueue({ type: "text-end", id: "text" });
                  controller.enqueue({
                    type: "finish",
                    finishReason: "stop",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  });
                  controller.close();
                }
                // The real SDK/server abort path must finish a deliberately stalled provider.
              },
            }),
          };
        },
      }) as unknown as LanguageModel,
  };
  app = buildApp({
    authToken: token,
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    providerFactory: factory,
    logStream: { write: () => {} },
    chatDeps: {
      retrieveFn: async () => ({
        candidates: [
          {
            beliefId: belief,
            beliefVersionId: version,
            subject: "PTY",
            attribute: "proof",
            value: "offline citation",
            vectorScore: 1,
            keywordScore: 1,
            fusedScore: 1,
            selected: true,
            reason: "top_k",
          },
        ],
        abstained: false,
        traceId: uuidv7(),
      }),
    },
  });
}, 180000);
afterAll(async () => {
  await app?.close();
  await t?.close();
});
it("real PTY ESC and Ctrl+C preserve two partials, continue the same context and commit only on idle exit", async () => {
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const { stdout } = await run(
    "python3",
    [
      path("./fixtures/cli-stream-pty.py"),
      process.execPath,
      path("../node_modules/tsx/dist/cli.mjs"),
      path("../../cli/tsconfig.json"),
      path("../../cli/src/index.ts"),
      url,
      project,
    ],
    {
      env: {
        PATH: process.env.PATH,
        TERM: "xterm-256color",
        NO_COLOR: "1",
        MNEMIC_AUTH_TOKEN: token,
        DEEPSEEK_API_KEY: "",
        DASHSCOPE_API_KEY: "",
      },
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    },
  ).catch((error: unknown) => {
    throw new Error(
      `PTY fixture failed: ${error instanceof Error && "stdout" in error ? String(error.stdout) : "no output"}`,
    );
  });
  const result = JSON.parse(stdout) as { exit_code: number; transcript: string };
  expect(result.exit_code).toBe(0);
  expect(calls).toBe(3);
  const rows =
    await t.sql`select m.speaker,m.raw_text,m.generation_status,c.id as conversation_id,c.ended_at from messages m join conversations c on c.id=m.conversation_id where c.project_id=${project} order by m.msg_time,m.id`;
  expect(rows).toHaveLength(6);
  expect(new Set(rows.map((r) => r.conversation_id)).size).toBe(1);
  expect(
    rows.filter((r) => r.speaker === "assistant").map((r) => [r.raw_text, r.generation_status]),
  ).toEqual([
    ["PTY partial 1", "interrupted"],
    ["PTY partial 2", "interrupted"],
    ["PTY completed", "complete"],
  ]);
  expect(rows.every((r) => r.ended_at !== null)).toBe(true);
  const third = JSON.stringify(prompts[2]);
  for (const text of [
    "PTY first user",
    "PTY partial 1",
    "PTY second user",
    "PTY partial 2",
    "PTY continue user",
    "generation_status=interrupted",
  ])
    expect(third).toContain(text);
  expect(result.transcript).not.toContain(token);
}, 65000);
