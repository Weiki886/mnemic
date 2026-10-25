import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as filesystem from "../src/file-context.js";

async function api() {
  const url = new URL("../src/file-input.ts", import.meta.url);
  expect(existsSync(url), "CLI file preparation/completion adapter must exist").toBe(true);
  return import(url.href) as Promise<typeof import("../src/file-input.js")>;
}
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mnemic35c-")));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "project data");
  await writeFile(join(root, "src", "a b.ts"), "literal data");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
it("maps files and directory lists to the shared attachment contract without client authority", async () => {
  const { prepareFileMessage } = await api();
  const prepared = await prepareFileMessage(root, "@README.md @src/");
  expect(prepared.attachments).toEqual([
    { kind: "file", path: "README.md", content: "project data", truncated: false },
    { kind: "directory", path: "src", content: '["a b.ts"]', truncated: false },
  ]);
  expect(prepared.notice).toContain("README.md");
  expect(prepared.notice).not.toContain("project data");
  expect(prepared.notice).not.toContain(root);
});
it("does no filesystem work for ordinary messages and never guesses a root for explicit references", async () => {
  const { prepareFileMessage } = await api();
  expect(await prepareFileMessage(undefined, "hello a@example.com")).toEqual({
    attachments: [],
    notice: "",
  });
  await expect(prepareFileMessage(undefined, "@README.md")).rejects.toThrow("invalid_root");
});
it("reports truncation and skipped automatic files before sending, without including their contents", async () => {
  const { prepareFileMessage } = await api();
  await writeFile(join(root, "README.md"), "x".repeat(20000));
  await writeFile(join(root, "package.json"), Buffer.from([0, 1]));
  const prepared = await prepareFileMessage(root, "@.");
  expect(prepared.attachments[0]?.truncated).toBe(true);
  expect(prepared.notice).toContain("截断");
  expect(prepared.notice).toContain("package.json");
  expect(prepared.notice).toContain("binary");
  expect(prepared.notice).not.toContain("x".repeat(100));
});
it.each(['@"unfinished', "@../secret", "@.env", "@missing", "@src/\ud800.ts"])(
  "rejects invalid references without falling back to plain text: %s",
  async (text) => {
    const { prepareFileMessage } = await api();
    await expect(prepareFileMessage(root, text)).rejects.toThrow();
  },
);
it("rejects a directory list that exceeds the transfer budget without silently dropping entries", async () => {
  const { prepareFileMessage } = await api();
  const folder = join(root, "many");
  await mkdir(folder);
  for (let n = 0; n < 100; n++) await writeFile(join(folder, `${n}-` + "x".repeat(180)), "");
  await expect(prepareFileMessage(root, "@many")).rejects.toThrow("invalid_context");
});
it("cancels a pending read promptly and ignores its late completion", async () => {
  const { prepareFileMessage } = await api();
  let finish!: (value: filesystem.FileContext) => void;
  vi.spyOn(filesystem, "loadFileContext").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const result = prepareFileMessage(root, "@README.md", controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow("cancelled");
  finish({ files: [], directories: [], warnings: [] });
});
it("quotes single file completion and preserves a suffix and Unicode cursor offsets", async () => {
  const { completeFileInput } = await api();
  const prefix = "🙂 看 @src/a";
  const result = await completeFileInput(root, {
    text: prefix + " 后续",
    cursor: Array.from(prefix).length,
  });
  expect(result.line.text).toBe('🙂 看 @"src/a b.ts" 后续');
  expect(result.line.cursor).toBe(Array.from('🙂 看 @"src/a b.ts"').length);
  expect(result.candidates).toEqual([]);
});
it("completes unfinished quotes and leaves the cursor inside a quoted directory", async () => {
  const { completeFileInput } = await api();
  await mkdir(join(root, "a folder"));
  const first = await completeFileInput(root, { text: '@"a f', cursor: 5 });
  expect(first.line.text).toBe('@"a folder/"');
  expect(first.line.cursor).toBe(Array.from('@"a folder/').length);
  await writeFile(join(root, "a folder", "entry.ts"), "x");
  const second = await completeFileInput(root, first.line);
  expect(second.line.text).toBe('@"a folder/entry.ts"');
  expect(second.line.cursor).toBe(Array.from(second.line.text).length);
});
it("lists multiple candidates without replacing the active input", async () => {
  const { completeFileInput } = await api();
  await writeFile(join(root, "src", "abc.ts"), "x");
  const line = { text: "explain @src/a", cursor: 14 };
  const result = await completeFileInput(root, line);
  expect(result.line).toEqual(line);
  expect(result.candidates).toEqual(['@"src/a b.ts"', "@src/abc.ts"]);
});
it("ignores email, escaped @ and slash command arguments", async () => {
  const { completeFileInput } = await api();
  for (const text of ["a@example.com", "@@README", "/config set @README"]) {
    const line = { text, cursor: Array.from(text).length };
    expect(await completeFileInput(root, line)).toEqual({ line, candidates: [] });
  }
});
