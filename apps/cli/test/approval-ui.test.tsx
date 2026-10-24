import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, cleanup } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatApp } from "../src/ChatApp.js";
import { ChatSession } from "../src/chat-session.js";
import { ApprovalController } from "../src/approval-controller.js";
import { ApprovalStore } from "../src/approval-store.js";
const project = "01920000-0000-7000-8000-000000000001";
let root: string, approval: ApprovalController;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mnemic-approval-ui-")));
  approval = await ApprovalController.create({
    projectId: project,
    root,
    mode: "confirm",
    store: new ApprovalStore(join(root, "grants")),
  });
  await writeFile(join(root, "old.ts"), "unchanged");
});
afterEach(async () => {
  cleanup();
  approval.dispose();
  await rm(root, { recursive: true, force: true });
});
function setup() {
  const row = {
    id: project,
    project_id: project,
    title: null,
    started_at: new Date(0).toISOString(),
    ended_at: null,
  };
  const api = {
    createConversation: vi.fn(async () => row),
    resumeConversation: vi.fn(),
    commitConversation: vi.fn(async () => ({
      ...row,
      ended_at: new Date(1).toISOString(),
      extraction_triggered: false,
    })),
    sendMessage: vi.fn(),
    listBeliefs: vi.fn(),
    deleteBelief: vi.fn(),
    recallBeliefs: vi.fn(),
    getConfig: vi.fn(),
    getProjectStatus: vi.fn(),
    updateProvider: vi.fn(),
  };
  const view = render(
    <ChatApp
      session={new ChatSession(api, project)}
      memoryApi={api}
      approval={approval}
      onDone={() => {}}
    />,
  );
  return { view, api };
}
it.each(["list", "revoke"])(
  "corrupt store %s failure identifies the directory without exposing or deleting records",
  async (action) => {
    const store = new ApprovalStore(join(root, "grants"));
    const id = await store.add({
      project_id: project,
      root,
      target: join(root, "new.ts"),
      operation: "file.create",
      scope: "permanent",
    });
    const file = join(root, "grants", `${id}.json`),
      corrupt = "{SECRET_BAD_RECORD_BODY";
    await writeFile(file, corrupt);
    const { view, api } = setup();
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
    const command = `/permissions ${action}${action === "revoke" ? ` ${id}` : ""}`;
    view.stdin.write(command);
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`> ${command}`));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("请手动检查授权目录"));
    // Ink may wrap a long absolute path; remove display line breaks only.
    const text = view.frames.join("\n").replace(/\n/g, "");
    expect(text).toContain(JSON.stringify(join(root, "grants")));
    expect(text).not.toContain("SECRET_BAD_RECORD_BODY");
    expect(await readFile(file, "utf8")).toBe(corrupt);
    expect(await approval.request({ kind: "file.create", target: "new.ts" })).toEqual({
      approved: false,
      reason: "storage_error",
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.commitConversation).not.toHaveBeenCalled();
  },
);
it("permissions status exposes the local store directory without loading a corrupt record", async () => {
  const store = new ApprovalStore(join(root, "grants"));
  const id = await store.add({
    project_id: project,
    root,
    target: join(root, "new.ts"),
    operation: "file.create",
    scope: "permanent",
  });
  await writeFile(join(root, "grants", `${id}.json`), "{bad-json");
  const { view, api } = setup();
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
  view.stdin.write("/permissions");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("> /permissions"));
  view.stdin.write("\r");
  await vi.waitFor(() => expect(view.frames.join("\n")).toContain("授权目录"));
  expect(view.frames.join("\n")).not.toContain("权限错误");
  expect(view.frames.join("\n").replace(/\n/g, "")).toContain(JSON.stringify(join(root, "grants")));
  expect(api.sendMessage).not.toHaveBeenCalled();
});
it.each(["\u001b1", "\u001b3", "\u001b[49;1:2u", "\u001b[49;1:3u", "\u001b[51;5u", "\u001b[51;9u"])(
  "modified confirmation %j never authorizes or persists a rule",
  async (key) => {
    const { view } = setup();
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
    const request = approval.request({ kind: "file.create", target: "new.ts" });
    await vi.waitFor(() => expect(view.lastFrame()).toContain("审批确认"));
    view.stdin.write(key);
    // A deny acts as a processing barrier; neither modified key may finish the approval.
    view.stdin.write("n");
    expect(await request).toMatchObject({ approved: false });
    expect(await approval.list()).toEqual([]);
  },
);
it("failed /new followed by send never reuses the archived conversation's grants", async () => {
  const { view, api } = setup();
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
  const request = approval.request({ kind: "file.create", target: "new.ts" });
  await vi.waitFor(() => expect(view.lastFrame()).toContain("审批确认"));
  view.stdin.write("2");
  await request;
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain("审批确认"));
  api.createConversation.mockRejectedValueOnce(new Error("temporary creation error"));
  view.stdin.write("/new");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("> /new"));
  view.stdin.write("\r");
  await vi.waitFor(() => expect(api.createConversation).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain("处理中"));
  const next = "01920000-0000-7000-8000-000000000002";
  api.createConversation.mockResolvedValueOnce({
    id: next,
    project_id: project,
    title: null,
    started_at: new Date(0).toISOString(),
    ended_at: null,
  });
  let grantsAtSend: unknown;
  api.sendMessage.mockImplementationOnce(async () => {
    // The boundary must be cleared BEFORE any future Tool runs during this request.
    grantsAtSend = await approval.list();
    return { message_id: next, answer: "ok", abstained: true, memories: [] };
  });
  view.stdin.write("recover");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("> recover"));
  view.stdin.write("\r");
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${next}`));
  await vi.waitFor(() => expect(view.frames.join("\n")).toContain("不记得"));
  expect(grantsAtSend).toEqual([]);
  expect(await approval.list()).toEqual([]);
});
it("lists and revokes session rules locally and drops them on /new", async () => {
  const { view, api } = setup();
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
  async function approve() {
    const request = approval.request({ kind: "file.create", target: "new.ts" });
    await vi.waitFor(() => expect(view.lastFrame()).toContain("审批确认"));
    view.stdin.write("2");
    expect(await request).toMatchObject({ approved: true });
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain("审批确认"));
  }
  async function command(text: string) {
    view.stdin.write(text);
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`> ${text}`));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain(`> ${text}`));
  }
  await approve();
  const [row] = await approval.list();
  await command("/permissions list");
  await vi.waitFor(() => expect(view.frames.join("\n")).toContain(row!.id));
  await command(`/permissions revoke ${row!.id}`);
  await vi.waitFor(() => expect(view.frames.join("\n")).toContain("授权已撤销"));
  expect(await approval.list()).toEqual([]);
  await approve();
  api.createConversation.mockResolvedValueOnce({
    id: "01920000-0000-7000-8000-000000000002",
    project_id: project,
    title: null,
    started_at: new Date(0).toISOString(),
    ended_at: null,
  });
  await command("/new");
  await vi.waitFor(async () => expect(await approval.list()).toEqual([]));
  expect(api.sendMessage).not.toHaveBeenCalled();
});
it("shows mode and switches locally without sending slash commands to the model", async () => {
  const { view, api } = setup();
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
  view.stdin.write("/permissions read-only");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("> /permissions read-only"));
  view.stdin.write("\r");
  await vi.waitFor(() => expect(approval.mode).toBe("read-only"));
  await vi.waitFor(() => expect(view.lastFrame()).toContain("权限 read-only"));
  expect(api.sendMessage).not.toHaveBeenCalled();
});
it("pending approval blocks chat text/Enter; explicit once approves just that request", async () => {
  const { view, api } = setup();
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
  const request = approval.request({ kind: "file.create", target: "new.ts" });
  await vi.waitFor(() => expect(view.lastFrame()).toContain("审批确认"));
  expect(view.lastFrame()).toContain(join(root, "new.ts"));
  view.stdin.write("ordinary text");
  view.stdin.write("\r");
  view.stdin.write("1");
  expect(await request).toMatchObject({ approved: true, reason: "confirmed" });
  expect(api.sendMessage).not.toHaveBeenCalled();
  const next = approval.request({ kind: "file.create", target: "new.ts" });
  await vi.waitFor(() => expect(approval.pending).not.toBeNull());
  view.stdin.write("n");
  expect(await next).toMatchObject({ approved: false });
});
it.each(["\u001b", "\u0003"])(
  "%j denies a pending shell without committing or allowing permanent scope",
  async (key) => {
    const { view, api } = setup();
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`会话 ${project}`));
    const request = approval.request({
      kind: "shell",
      cwd: ".",
      command: "echo NEVER_EXECUTE\nsecond line\u0085\u202e",
    });
    await vi.waitFor(() => expect(view.lastFrame()).toContain("审批确认"));
    expect(view.lastFrame()).toContain("echo NEVER_EXECUTE\\nsecond line");
    expect(view.lastFrame()).toContain("\\u0085\\u202e");
    expect(view.lastFrame()).not.toContain("3 永久");
    view.stdin.write("3");
    view.stdin.write(key);
    expect(await request).toMatchObject({ approved: false });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.commitConversation).not.toHaveBeenCalled();
  },
);
