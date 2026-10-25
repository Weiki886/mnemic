import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModel } from "ai";
import { buildApp } from "../src/app.js";
import { waitForChatJobs } from "../src/chat/jobs.js";
import { createProvider } from "../src/providers/repository.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
import { TEST_MASTER_KEY } from "./test-keys.js";
import { bagEmbeddingFactory } from "./fixtures/bag-embedding.js";
const run = promisify(execFile),
  path = (value: string) => fileURLToPath(new URL(value, import.meta.url));
const token = "offline-file-pty-test-token-0000000",
  secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
let t: TestDb, root: string, app: ReturnType<typeof buildApp>;
let calls = 0,
  extractions = 0;
const prompts: string[] = [],
  project = uuidv7();
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mnemic35c-pty-")));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "src", "entry file.ts"), `FILE_SOURCE chooses PostgreSQL ${secret}`);
  await writeFile(join(root, "README.md"), "r".repeat(20000));
  await writeFile(join(root, "docs", "README.md"), "FILE_DOC uses pnpm");
  t = await setupTestDb();
  await t.sql`delete from provider_configs`;
  await t.sql`insert into projects(id,name) values(${project},'CLI FILE PTY')`;
  await createProvider(t.db, TEST_MASTER_KEY, {
    name: "offline-file-pty",
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid",
    apiKey: "offline",
    models: { chat: "chat", extraction: "extract", embedding: "bag" },
  });
  const factory = {
    ...bagEmbeddingFactory,
    languageModel: () =>
      new MockLanguageModelV2({
        doGenerate: async (opts) => {
          extractions++;
          const prompt = JSON.stringify(opts.prompt);
          prompts.push(prompt);
          const name = prompt.includes("FILE_SOURCE")
            ? "database"
            : prompt.includes("FILE_DOC")
              ? "package-manager"
              : null;
          return {
            content: [
              {
                type: "text",
                text: name
                  ? JSON.stringify([
                      {
                        type: "decision",
                        subject: "pty-files",
                        attribute: name,
                        value: name === "database" ? "PostgreSQL" : "pnpm",
                        valid_time: "2026-10-25",
                        time_precision: "DAY",
                        time_confidence: 0.95,
                        assertion_intent: "ASSERT",
                        source_type: "USER_CORRECTION",
                        importance: 0.95,
                        confidence: 0.95,
                        entities: ["pty-files"],
                        is_profile: true,
                      },
                    ])
                  : "[]",
              },
            ],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        },
        doStream: async (opts) => {
          calls++;
          prompts.push(JSON.stringify(opts.prompt));
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: "PTY FILE ANSWER" });
                controller.enqueue({ type: "text-end", id: "t" });
                controller.enqueue({
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
                controller.close();
              },
            }),
          };
        },
      }) as unknown as LanguageModel,
  };
  app = buildApp({
    db: t.db,
    masterKey: TEST_MASTER_KEY,
    authToken: token,
    providerFactory: factory,
    logStream: { write: () => {} },
    chatDeps: { retrieveFn: async () => ({ candidates: [], abstained: true, traceId: uuidv7() }) },
  });
}, 180000);
afterAll(async () => {
  await app?.close();
  await t?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
it("real PTY Tab, retained invalid draft, truncation, directory, HTTP and Evidence provenance close the file-reference loop", async () => {
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const { stdout } = await run(
    "python3",
    [
      path("./fixtures/cli-files-pty.py"),
      process.execPath,
      path("../node_modules/tsx/dist/cli.mjs"),
      path("../../cli/tsconfig.json"),
      path("../../cli/src/index.ts"),
      url,
      project,
      root,
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
      maxBuffer: 3 * 1024 * 1024,
    },
  ).catch((error: unknown) => {
    throw new Error(
      `File PTY fixture failed: ${error instanceof Error && "stdout" in error ? String(error.stdout) : "no output"}`,
    );
  });
  const result = JSON.parse(stdout) as { exit_code: number; transcript: string };
  expect(result.exit_code).toBe(0);
  expect(calls).toBe(1);
  await waitForChatJobs();
  const rows =
    await t.sql`select m.*,c.ended_at from messages m join conversations c on c.id=m.conversation_id where c.project_id=${project} order by m.id`;
  expect(rows).toHaveLength(6);
  expect(rows.some((row) => row.raw_text === "@missing")).toBe(false);
  expect(rows.every((row) => row.ended_at !== null)).toBe(true);
  const files = rows.filter((row) => row.attachment);
  expect(files).toHaveLength(4);
  const directive = rows.find((row) => row.speaker === "user")!;
  expect(
    files.every(
      (row) =>
        row.attachment.source_type === "PROJECT_FILE" &&
        row.attachment.parent_message_id === directive.id,
    ),
  ).toBe(true);
  expect(files.find((row) => row.attachment.path === "README.md")).toMatchObject({
    raw_text: "r".repeat(16384),
    attachment: { truncated: true },
  });
  expect(files.find((row) => row.attachment.kind === "directory")).toMatchObject({
    raw_text: '["README.md"]',
    attachment: { path: "docs" },
  });
  const observations = await t.sql`select * from observations where project_id=${project}`;
  expect(observations).toHaveLength(2);
  expect(
    observations.every(
      (row) =>
        row.source_type === "PROJECT_FILE" &&
        row.authority === 50 &&
        Number(row.reliability) === 0.9 &&
        files.some((file) => file.id === row.evidence_id),
    ),
  ).toBe(true);
  expect(extractions).toBe(5); // user directive + four file/directory Evidence; commit adds none.
  expect(
    (await t.sql`select evidence_count from beliefs where project_id=${project}`).every(
      (row) => row.evidence_count === 1,
    ),
  ).toBe(true);
  expect(JSON.stringify(rows) + prompts.join("\n") + result.transcript).not.toContain(secret);
  expect(result.transcript).not.toContain(token);
  expect(prompts[0]).toContain("PROJECT_FILE");
  expect(prompts[0]).not.toContain(root);
  expect(result.transcript.indexOf("已截断")).toBeLessThan(
    result.transcript.indexOf("PTY FILE ANSWER"),
  );
}, 65000);
