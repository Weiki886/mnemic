import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import type { RecallResult } from "@mnemic/shared";
import { ChatApp } from "../src/ChatApp.js";
import { ChatSession } from "../src/chat-session.js";
const project = "01920000-0000-7000-8000-000000000001";
const id = "01920000-0000-7000-8000-000000000002";
const row = {
  id,
  project_id: project,
  title: null,
  started_at: "2026-10-22T00:00:00Z",
  ended_at: null,
};
const response: RecallResult = {
  project_id: project,
  query: "PostgreSQL",
  abstained: true,
  candidates: [],
  trace: { id, reinforce_enabled: false, candidate_count: 0, truncated: false, candidates: [] },
};
function fixture() {
  const api = {
    createConversation: vi.fn(async () => row),
    commitConversation: vi.fn(async () => ({
      ...row,
      ended_at: row.started_at,
      extraction_triggered: false,
    })),
    sendMessage: vi.fn(async () => {
      throw new Error("no chat for slash commands");
    }),
    resumeConversation: vi.fn(async () => ({ ...row, resumed_from: id, messages: [] })),
    listBeliefs: vi.fn(async () => []),
    deleteBelief: vi.fn(async () => ({ id, status: "deleted" })),
    recallBeliefs: vi.fn(async (): Promise<RecallResult> => response),
  };
  const done = vi.fn();
  const view = render(
    <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
  );
  return { api, done, view };
}
afterEach(cleanup);
describe("recall inside Ink", () => {
  it("Tab + arguments + Enter invokes manual recall, not paid chat or lifecycle mutation", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(`会话 ${id}`));
    f.view.stdin.write("/rec");
    f.view.stdin.write("\t");
    f.view.stdin.write("PostgreSQL");
    f.view.stdin.write("\r");
    await vi.waitFor(() => expect(f.api.recallBeliefs).toHaveBeenCalledWith(project, "PostgreSQL"));
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain(`trace ${id}`));
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(f.api.commitConversation).not.toHaveBeenCalled();
    expect(f.api.resumeConversation).not.toHaveBeenCalled();
  });
  it("Ctrl+C drains one pending recall before committing, without repeated request", async () => {
    const f = fixture();
    let release!: (r: RecallResult) => void;
    f.api.recallBeliefs.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(`会话 ${id}`));
    f.view.stdin.write("/recall PostgreSQL");
    f.view.stdin.write("\r");
    await vi.waitFor(() => expect(f.api.recallBeliefs).toHaveBeenCalledOnce());
    f.view.stdin.write("\r");
    f.view.stdin.write("\u0003");
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("等待请求结束"));
    expect(f.api.commitConversation).not.toHaveBeenCalled();
    release(response);
    await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(0));
    expect(f.api.recallBeliefs).toHaveBeenCalledOnce();
    expect(f.api.commitConversation).toHaveBeenCalledOnce();
  });
});
