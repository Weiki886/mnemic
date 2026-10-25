import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatSession } from "../src/chat-session.js";
import { ChatApp } from "../src/ChatApp.js";
import * as fileInput from "../src/file-input.js";
import * as filesystem from "../src/file-context.js";
const p = "01920000-0000-7000-8000-000000000001",
  c = "01920000-0000-7000-8000-000000000002";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mnemic35c-ui-")));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "project data");
  await writeFile(join(root, "src", "a b.ts"), "spaced file");
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function fixture() {
  const row = {
    id: c,
    project_id: p,
    title: null,
    started_at: "2026-10-25T00:00:00Z",
    ended_at: null,
  };
  const client = {
    createConversation: vi.fn(async () => row),
    sendMessage: vi.fn(async () => ({
      message_id: c,
      answer: "file answer",
      memories: [],
      abstained: true,
    })),
    commitConversation: vi.fn(async () => ({
      ...row,
      ended_at: "2026-10-25T01:00:00Z",
      extraction_triggered: false,
    })),
    resumeConversation: vi.fn(async () => ({ ...row, resumed_from: c, messages: [] })),
    getBelief: vi.fn(),
    listBeliefs: vi.fn(),
    deleteBelief: vi.fn(),
    recallBeliefs: vi.fn(),
    getProjectStatus: vi.fn(),
    getConfig: vi.fn(),
    updateProvider: vi.fn(),
    listApprovalAudits: vi.fn(),
  };
  const onDone = vi.fn();
  return {
    client,
    onDone,
    ui: render(
      <ChatApp session={new ChatSession(client, p, root)} memoryApi={client} onDone={onDone} />,
    ),
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.ui.lastFrame()).toContain(`会话 ${c}`));
}
it("keeps invalid reference input intact and does not dispatch or degrade to plain chat", async () => {
  const f = fixture();
  await ready(f);
  f.ui.stdin.write('@"unfinished');
  f.ui.stdin.write("\r");
  await vi.waitFor(() => expect(f.ui.lastFrame()).toContain("未发送"));
  expect(f.ui.lastFrame()).toMatch(/> @"unfinished\s*$/u);
  expect(f.client.sendMessage).not.toHaveBeenCalled();
});
it("shows truncation and file context without falsely saying the supplied files are not remembered", async () => {
  await writeFile(join(root, "README.md"), "x".repeat(20000));
  const f = fixture();
  await ready(f);
  f.ui.stdin.write("解释 @README.md");
  f.ui.stdin.write("\r");
  await vi.waitFor(() => expect(f.client.sendMessage).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.ui.lastFrame()).toContain("file answer"));
  expect(f.ui.lastFrame()).toContain("截断");
  expect(f.ui.lastFrame()).toContain("项目文件上下文");
  expect(f.ui.lastFrame()).not.toContain("不记得：");
});
it("Tab completes a quoted file path and sends its real content from the configured root", async () => {
  const f = fixture();
  await ready(f);
  f.ui.stdin.write("解释 @src/a");
  f.ui.stdin.write("\t");
  await vi.waitFor(() => expect(f.ui.lastFrame()).toContain('@"src/a b.ts"'));
  f.ui.stdin.write("\r");
  await vi.waitFor(() =>
    expect(f.client.sendMessage).toHaveBeenCalledWith(p, c, '解释 @"src/a b.ts"', [
      expect.objectContaining({ path: "src/a b.ts", content: "spaced file" }),
    ]),
  );
});
it("discards stale async Tab results when the user has edited the input", async () => {
  let finish!: (value: Awaited<ReturnType<typeof fileInput.completeFileInput>>) => void;
  vi.spyOn(fileInput, "completeFileInput").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture();
  await ready(f);
  f.ui.stdin.write("@R");
  f.ui.stdin.write("\t");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.ui.stdin.write("x");
  finish({ line: { text: "@README.md", cursor: 10 }, candidates: ["STALE_CANDIDATE"] });
  await vi.waitFor(() => expect(f.ui.lastFrame()).toContain("@Rx"));
  expect(f.ui.lastFrame()).not.toContain("STALE_CANDIDATE");
  expect(f.ui.lastFrame()).not.toContain("@README.md");
});
it("ESC cancels file preparation, keeps the draft and does not exit or send", async () => {
  let finish!: (value: filesystem.FileContext) => void;
  vi.spyOn(filesystem, "loadFileContext").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture();
  await ready(f);
  f.ui.stdin.write("@README.md");
  f.ui.stdin.write("\r");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.ui.stdin.write("\x1b");
  await vi.waitFor(() => expect(f.ui.lastFrame()).toContain("已取消文件引用"));
  expect(f.ui.lastFrame()).toMatch(/> @README\.md\s*$/u);
  expect(f.client.sendMessage).not.toHaveBeenCalled();
  expect(f.onDone).not.toHaveBeenCalled();
  finish({ files: [], directories: [], warnings: [] });
});
