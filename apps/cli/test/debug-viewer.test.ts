import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, truncate, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.js";
const p = "11111111-1111-4111-8111-111111111111",
  c = "22222222-2222-4222-8222-222222222222",
  id = "33333333-3333-4333-8333-333333333333",
  other = "44444444-4444-4444-8444-444444444444";
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
const row = (text = "FULL PRIVATE PROMPT") => ({
  ts: "2026-10-26T09:00:00.000Z",
  event: "model.prompt",
  target_id: id,
  msg: "model debug content",
  level: 20,
  detail: {
    project_id: p,
    conversation_id: c,
    evidence_id: id,
    provider_name: "local",
    model_id: "chat",
    slot: "chat",
    complete: true,
    omitted_reason: null,
    content: [{ role: "system", content: text }],
  },
});
const meta = () => ({
  ts: row().ts,
  event: "memory.write.completed",
  target_id: id,
  msg: "memory debug trace",
  detail: {
    project_id: p,
    conversation_id: c,
    route: "created",
    observation_id: id,
    belief_id: id,
    relation: null,
  },
});
async function fixture(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "mnemic-debug-test-"));
  paths.push(dir);
  const file = join(dir, "debug log.jsonl");
  await writeFile(file, lines.join("\n") + "\n");
  const fetch = vi.fn(() => {
    throw Error("network forbidden");
  });
  const call = async (extra: string[] = []) => {
    let output = "";
    const code = await runCli(["debug", "--file", file, "--project", p, ...extra], {
      fetch,
      env: { MNEMIC_SERVER_URL: "invalid secret url", MNEMIC_AUTH_TOKEN: "not-used-token" },
      write: (s) => {
        output += s;
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    return { code, output };
  };
  return { file, dir, call };
}
it("reads local operator logs without network/auth and defaults to metadata only", async () => {
  const f = await fixture([JSON.stringify(row()), JSON.stringify(meta())]);
  const { code, output } = await f.call(["--json"]);
  expect(code).toBe(0);
  expect(output).not.toContain("FULL PRIVATE PROMPT");
  const parsed = JSON.parse(output);
  expect(parsed.records).toHaveLength(2);
  expect(parsed.records[0].detail).not.toHaveProperty("content");
  expect(parsed).toMatchObject({ matched: 2, shown: 2, ignored: 0, limited: false });
});
it("requires --content for full, untruncated prompt/response display, and filters project/conversation/target", async () => {
  const response = {
    ...row(),
    event: "model.response",
    detail: {
      ...row().detail,
      status: "success",
      content: [{ type: "text", text: "FULL RAW OUTPUT" }],
    },
  };
  const f = await fixture(
    [
      row(),
      response,
      { ...row(), detail: { ...row().detail, project_id: other } },
      { ...row(), target_id: other, detail: { ...row().detail, conversation_id: other } },
      meta(),
    ].map((r) => JSON.stringify(r)),
  );
  const result = await f.call([
    "--conversation",
    c.toUpperCase(),
    "--target",
    id,
    "--content",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.output);
  expect(parsed.records).toHaveLength(3);
  expect(result.output).toContain("FULL PRIVATE PROMPT");
  expect(result.output).toContain("FULL RAW OUTPUT");
  expect(
    parsed.records.every(
      (r: { detail: { conversation_id: string } }) => r.detail.conversation_id === c,
    ),
  ).toBe(true);
});
it("bounds displayed events while keeping exact match/ignored counts; never echoes corrupt/ordinary records", async () => {
  const f = await fixture([
    "launcher secret",
    JSON.stringify({ msg: "unhandled error", err: "private error" }),
    "{truncated SECRET",
    JSON.stringify(row()),
    JSON.stringify(row()),
    JSON.stringify(meta()),
  ]);
  const { code, output } = await f.call(["--limit", "1", "--json"]);
  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ matched: 3, shown: 1, ignored: 3, limited: true });
  expect(output).not.toMatch(/secret|SECRET|private error|FULL PRIVATE PROMPT/);
});
it.each([{ flags: [] }, { flags: ["--json"] }])(
  "escapes terminal controls, bidi and multiline text without executing them (%j)",
  async ({ flags }) => {
    const text = "FULL\n\u001b]52;c;SECRET\u0007\u009b31m\u202e";
    const f = await fixture([JSON.stringify(row(text))]);
    const { code, output } = await f.call(["--content", ...flags]);
    expect(code).toBe(0);
    for (const control of [27, 7, 155, 0x202e])
      expect(output).not.toContain(String.fromCharCode(control));
    if (flags.length) expect(JSON.parse(output).records[0].detail.content[0].content).toBe(text);
    else {
      expect(output).toContain("\\n");
      expect(output).toContain("\\u001b");
    }
  },
);
it.each(
  [
    ["--project", p],
    ["--file", "another"],
    ["--limit", "0"],
    ["--limit", "1001"],
    ["--conversation", "secret"],
    ["--conversation="],
    ["--target="],
    ["--target", "secret"],
    ["--server", "https://example.invalid"],
    ["--probe"],
    ["--content", "--content"],
  ].map((extra) => ({ extra })),
)("rejects malformed/duplicate/remote flags before file/network access (%j)", async ({ extra }) => {
  const f = await fixture([]);
  const { code, output } = await f.call(extra);
  expect(code).toBe(2);
  expect(output).not.toContain("another");
  expect(output).not.toContain("secret");
});
it("requires explicit project and file even in offline mode", async () => {
  let output = "";
  expect(
    await runCli(["debug"], {
      write: (s) => {
        output += s;
      },
      fetch: vi.fn(),
    }),
  ).toBe(2);
  expect(output).toContain("--project");
  expect(output).toContain("--file");
});
it("rejects unreadable, symlink and non-regular files without echoing path/OS errors", async () => {
  const f = await fixture([]);
  await rm(f.file);
  await symlink("/does-not-exist-SECRET", f.file);
  expect(await f.call()).toMatchObject({ code: 1 });
  await rm(f.file);
  await mkdir(f.file);
  const result = await f.call();
  expect(result.code).toBe(1);
  expect(result.output).not.toContain(f.dir);
});
it("rejects oversized sparse files and overlong lines atomically, with no preceding content output", async () => {
  const f = await fixture([JSON.stringify(row())]);
  await truncate(f.file, 64 * 1024 * 1024 + 1);
  expect(await f.call(["--content"])).toMatchObject({ code: 1 });
  await writeFile(f.file, JSON.stringify(row()) + "\n" + "x".repeat(16 * 1024 * 1024 + 1));
  const result = await f.call(["--content"]);
  expect(result.code).toBe(1);
  expect(result.output).not.toContain("FULL PRIVATE PROMPT");
});
it("rejects incompatible capture fields instead of dumping extra content", async () => {
  const f = await fixture([
    JSON.stringify({ ...row(), detail: { ...row().detail, api_key: "SECRET_KEY" } }),
  ]);
  const result = await f.call(["--content", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output)).toMatchObject({ shown: 0, ignored: 1 });
  expect(result.output).not.toContain("SECRET_KEY");
});
