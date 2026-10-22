import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { ApiError, type BeliefListItem } from "@mnemic/shared";
import { ChatApp } from "../src/ChatApp.js";
import { ChatSession } from "../src/chat-session.js";

const project = "01920000-0000-7000-8000-000000000001";
const conversation = "01920000-0000-7000-8000-000000000002";
const id = "a1920000-0000-7000-8000-000000000003";
const row = {
  id: conversation,
  project_id: project,
  title: null,
  started_at: "2026-10-21T00:00:00Z",
  ended_at: null,
};
const memory: BeliefListItem = {
  id,
  subject: "project",
  attribute: "database",
  type: "decision",
  status: "active",
  is_profile: false,
  confidence: 0.9,
  salience: 0.5,
  importance: null,
  evidence_count: 1,
  created_at: row.started_at,
  current_value: "PostgreSQL",
};
function fixture() {
  const api = {
    recallBeliefs: vi.fn(async () => {
      throw new Error("unexpected recall");
    }),
    createConversation: vi.fn(async () => row),
    resumeConversation: vi.fn(async () => ({ ...row, resumed_from: id, messages: [] })),
    commitConversation: vi.fn(async () => ({
      ...row,
      ended_at: row.started_at,
      extraction_triggered: false,
    })),
    sendMessage: vi.fn(async () => {
      throw new Error("command must not call chat");
    }),
    listBeliefs: vi.fn(async () => [memory]),
    deleteBelief: vi.fn(async () => ({ id, status: "deleted" })),
  };
  const done = vi.fn();
  const view = render(
    <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
  );
  const input = async (text: string) => {
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conversation));
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain("处理中"));
    view.stdin.write(text);
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`> ${text}`));
    view.stdin.write("\r");
  };
  return { api, view, input, done };
}
afterEach(cleanup);

describe("memory slash commands in Ink (#32)", () => {
  it("cursor movement and argument edits do not depend on a render between keys", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(conversation));
    await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
    f.view.stdin.write("/memory db");
    f.view.stdin.write("\u001b[D");
    f.view.stdin.write("a");
    f.view.stdin.write("\u001b[F");
    f.view.stdin.write("\u007f");
    f.view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(f.api.listBeliefs).toHaveBeenCalledWith(project, {
        status: "active",
        limit: 20,
        offset: 0,
        q: "da",
      }),
    );
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it("completion followed immediately by arguments cannot become a paid chat message", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(conversation));
    await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
    f.view.stdin.write("/m");
    f.view.stdin.write("\t");
    f.view.stdin.write("database");
    f.view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(f.api.listBeliefs).toHaveBeenCalledWith(project, {
        status: "active",
        limit: 20,
        offset: 0,
        q: "database",
      }),
    );
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it("Enter submits latest controlled input before the text input rerenders", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(conversation));
    await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
    f.view.stdin.write("/memory");
    f.view.stdin.write("\r");
    await vi.waitFor(() => expect(f.api.listBeliefs).toHaveBeenCalledOnce());
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it("Tab reads latest input even before the preceding key causes a render", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(conversation));
    await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
    f.view.stdin.write("/m");
    f.view.stdin.write("\t");
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("> /memory"));
    expect(f.api.listBeliefs).not.toHaveBeenCalled();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it("Tab memory -> list -> forget -> list, without sending messages or changing sessions", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(conversation));
    f.view.stdin.write("/m");
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("> /m"));
    f.view.stdin.write("\t");
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("> /memory"));
    f.view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(f.api.listBeliefs).toHaveBeenCalledWith(project, {
        status: "active",
        limit: 20,
        offset: 0,
      }),
    );
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("PostgreSQL"));
    await f.input(`/forget ${id.toUpperCase()}`);
    await vi.waitFor(() => expect(f.api.deleteBelief).toHaveBeenCalledWith(project, id));
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("软删除已确认"));
    f.api.listBeliefs.mockResolvedValueOnce([]);
    await f.input("/memory --type decision --limit 1 --offset 2 database");
    await vi.waitFor(() =>
      expect(f.api.listBeliefs).toHaveBeenLastCalledWith(project, {
        status: "active",
        type: "decision",
        limit: 1,
        offset: 2,
        q: "database",
      }),
    );
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("本页暂无记忆"));
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(f.api.commitConversation).not.toHaveBeenCalled();
    expect(f.api.resumeConversation).not.toHaveBeenCalled();
    expect(f.api.createConversation).toHaveBeenCalledOnce();
  });

  it("Ctrl+C waits for pending soft delete, then commits once; duplicate Enter does not repeat deletion", async () => {
    const f = fixture();
    let release!: (value: { id: string; status: string }) => void;
    f.api.deleteBelief.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await f.input(`/forget ${id}`);
    await vi.waitFor(() => expect(f.api.deleteBelief).toHaveBeenCalledOnce());
    f.view.stdin.write("\r");
    f.view.stdin.write("\u0003");
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("等待请求结束"));
    expect(f.api.commitConversation).not.toHaveBeenCalled();
    expect(f.done).not.toHaveBeenCalled();
    release({ id, status: "deleted" });
    await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(0));
    expect(f.api.commitConversation).toHaveBeenCalledOnce();
    expect(f.api.deleteBelief).toHaveBeenCalledOnce();
  });

  it("invalid memory arguments retain input and never reach server", async () => {
    const f = fixture();
    await f.input("/memory --limit 0");
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("命令无效"));
    expect(f.view.lastFrame()).toContain("> /memory --limit 0");
    expect(f.api.listBeliefs).not.toHaveBeenCalled();
    expect(f.api.deleteBelief).not.toHaveBeenCalled();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });

  it("unconfirmed delete and auth errors do not leak upstream content or retry", async () => {
    const f = fixture();
    f.api.deleteBelief.mockRejectedValueOnce(new Error("private-upstream-secret"));
    await f.input(`/forget ${id}`);
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("软删除结果未确认"));
    f.api.listBeliefs.mockRejectedValueOnce(new ApiError(401, null, "private-token"));
    await f.input("/memory");
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("MNEMIC_AUTH_TOKEN"));
    expect(f.view.frames.join("\n")).not.toContain("private-");
    expect(f.api.deleteBelief).toHaveBeenCalledOnce();
  });
});
