import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@mnemic/shared";
const commands = await import("../src/management-commands.js").catch(() => ({}));
const id = "01920000-0000-7000-8000-000000000001",
  conversation = "01920000-0000-7000-8000-000000000002";
const provider = {
  id,
  name: "provider",
  protocol: "openai-compatible",
  base_url: "https://host/v1",
  models: { chat: "model" },
  created_at: "2026-10-22T00:00:00Z",
};
const slots = {
  chat: { provider_id: id, provider_name: "provider", model: "model" },
  extraction: null,
  embedding: null,
};
const config = { config_source: "server", providers: [provider], slots };
const status = {
  project: { id, name: "project" },
  conversation: { id: conversation, ended_at: null },
  counts: { total: 2, active: 1, deleted: 1, retracted: 0, superseded: 0, expired: 0 },
  slots,
};
const run = (api: unknown, command: unknown) => {
  expect(commands).toHaveProperty("runManagementCommand");
  return (
    commands as {
      runManagementCommand(a: unknown, p: string, c: string, cmd: unknown): Promise<string>;
    }
  ).runManagementCommand(api, id, conversation, command);
};
describe("management CLI runner", () => {
  it("shows scoped exact counts/current session and effective models", async () => {
    const getProjectStatus = vi.fn(async () => status);
    const text = await run({ getProjectStatus }, { name: "status" });
    expect(getProjectStatus).toHaveBeenCalledWith(id, conversation);
    expect(text).toContain("active=1");
    expect(text).toContain("total=2");
    expect(text).toContain(conversation);
    expect(text).toContain("model");
  });
  it("shows safe global config and explicitly unconfigured slots, without extra requests", async () => {
    const getConfig = vi.fn(async () => config);
    const text = await run({ getConfig }, { name: "config", action: "show" });
    expect(text).toContain("全局");
    expect(text).toContain("未配置");
    expect(text).toContain("https://host/v1");
    expect(getConfig).toHaveBeenCalledOnce();
  });
  it("only confirms matching provider and submitted values", async () => {
    const updateProvider = vi.fn(async () => ({ ...provider, models: { chat: "next" } }));
    const cmd = { name: "config", action: "set", id, patch: { models: { chat: "next" } } };
    expect(await run({ updateProvider }, cmd)).toContain("配置修改已确认");
    expect(updateProvider).toHaveBeenCalledWith(id, { models: { chat: "next" } });
    updateProvider.mockResolvedValueOnce(provider);
    await expect(run({ updateProvider }, cmd)).rejects.toThrow("修改未确认");
    expect(updateProvider).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...status, project: { id: conversation, name: "foreign" } },
    { ...status, conversation: { id, ended_at: null } },
    { ...status, counts: { ...status.counts, total: 10 } },
  ])("rejects incompatible or cross-project status %#", async (body) => {
    await expect(run({ getProjectStatus: async () => body }, { name: "status" })).rejects.toThrow(
      "读取失败",
    );
  });
  it.each([401, 404, 409, 500])("does not print upstream secrets or retry %s", async (status) => {
    const updateProvider = vi.fn(async () => {
      throw new ApiError(status, null, "private-secret-key");
    });
    const error = await run(
      { updateProvider },
      { name: "config", action: "set", id, patch: { name: "new" } },
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-secret-key");
    expect(updateProvider).toHaveBeenCalledOnce();
  });
});
