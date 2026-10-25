import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import type { ServerConfig, ProjectStatus, ProviderConfig } from "@mnemic/shared";
import { ChatApp } from "../src/ChatApp.js";
import { ChatSession } from "../src/chat-session.js";
const project = "01920000-0000-7000-8000-000000000001",
  id = "01920000-0000-7000-8000-000000000002";
const row = {
  id,
  project_id: project,
  title: null,
  started_at: "2026-10-22T00:00:00Z",
  ended_at: null,
};
const provider: ProviderConfig = {
  id,
  name: "p",
  protocol: "openai-compatible",
  base_url: "https://host/v1",
  models: { chat: "old" },
  created_at: row.started_at,
};
const config: ServerConfig = {
  config_source: "server",
  providers: [provider],
  slots: {
    chat: { provider_id: id, provider_name: "p", model: "old" },
    extraction: null,
    embedding: null,
  },
};
const status: ProjectStatus = {
  project: { id: project, name: "project" },
  conversation: { id, ended_at: null },
  counts: { total: 1, active: 1, deleted: 0, retracted: 0, superseded: 0, expired: 0 },
  slots: config.slots,
};
function fixture(startFails = false) {
  const api = {
    createConversation: vi.fn(async () => row),
    commitConversation: vi.fn(async () => ({
      ...row,
      ended_at: row.started_at,
      extraction_triggered: false,
    })),
    resumeConversation: vi.fn(async () => ({ ...row, resumed_from: id, messages: [] })),
    sendMessage: vi.fn(async () => {
      throw new Error("no paid messages");
    }),
    listBeliefs: vi.fn(async () => []),
    deleteBelief: vi.fn(async () => ({ id, status: "deleted" })),
    recallBeliefs: vi.fn(async () => {
      throw new Error("no recall");
    }),
    listApprovalAudits: vi.fn(),
    getConfig: vi.fn(async () => config),
    getProjectStatus: vi.fn(async () => status),
    updateProvider: vi.fn(async (): Promise<ProviderConfig> => provider),
  };
  if (startFails) api.createConversation.mockRejectedValueOnce(new Error("fixture-create-failed"));
  const done = vi.fn();
  const view = render(
    <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
  );
  return { api, done, view };
}
afterEach(cleanup);
describe("management commands inside Ink", () => {
  it("reports a missing conversation locally while config remains usable", async () => {
    const f = fixture(true);
    await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
    expect(f.api.createConversation).toHaveBeenCalledOnce();
    f.view.stdin.write("/status");
    f.view.stdin.write("\r");
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("会话尚未创建"));
    expect(f.api.getProjectStatus).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
    f.view.stdin.write("/config");
    f.view.stdin.write("\r");
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("全局服务端配置"));
    expect(f.api.getConfig).toHaveBeenCalledOnce();
    expect(f.api.createConversation).toHaveBeenCalledOnce();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
  it("reads config and status without messages, extraction or model probe", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(`会话 ${id}`));
    f.view.stdin.write("/c");
    f.view.stdin.write("\t");
    f.view.stdin.write("\r");
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("全局服务端配置"));
    await vi.waitFor(() => expect(f.view.lastFrame()).not.toContain("处理中"));
    f.view.stdin.write("/status");
    f.view.stdin.write("\r");
    await vi.waitFor(() => expect(f.api.getProjectStatus).toHaveBeenCalledWith(project, id));
    await vi.waitFor(() => expect(f.view.frames.join("\n")).toContain("active=1"));
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(f.api.commitConversation).not.toHaveBeenCalled();
    expect(f.api.recallBeliefs).not.toHaveBeenCalled();
  });
  it("waits one in-flight global config patch before Ctrl+C commits", async () => {
    const f = fixture();
    let release!: (p: ProviderConfig) => void;
    f.api.updateProvider.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain(`会话 ${id}`));
    f.view.stdin.write(`/config set ${id} chat new`);
    f.view.stdin.write("\r");
    await vi.waitFor(() =>
      expect(f.api.updateProvider).toHaveBeenCalledWith(id, { models: { chat: "new" } }),
    );
    f.view.stdin.write("\r");
    f.view.stdin.write("\u0003");
    await vi.waitFor(() => expect(f.view.lastFrame()).toContain("等待请求结束"));
    expect(f.api.commitConversation).not.toHaveBeenCalled();
    release({ ...provider, models: { chat: "new" } });
    await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(0));
    expect(f.api.updateProvider).toHaveBeenCalledOnce();
    expect(f.api.commitConversation).toHaveBeenCalledOnce();
  });
});
