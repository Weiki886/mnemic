import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { ChatSession } from "../src/chat-session.js";
import { formatReply } from "../src/presentation.js";
import type { ChatResume } from "@mnemic/shared";

const project = "a1920000-0000-7000-8000-000000000001";
const source = "b1920000-0000-7000-8000-000000000002";
const fork = "c1920000-0000-7000-8000-000000000003";
const next = "d1920000-0000-7000-8000-000000000004";
const row = (id = fork) => ({
  id,
  project_id: project,
  title: null,
  started_at: "2026-10-20T00:00:00Z",
  ended_at: null,
});
const history = [
  {
    id: source,
    speaker: "user" as const,
    raw_text: "昨天确定42",
    msg_time: "2026-10-19T00:00:00Z",
    memories: null,
  },
];
const fixture = () => ({
  createConversation: vi.fn(async () => row(next)),
  sendMessage: vi.fn(async () => ({
    message_id: next,
    answer: "42",
    abstained: true,
    history_included: true,
    memories: [],
  })),
  commitConversation: vi.fn(async (id: string) => ({
    ...row(id),
    ended_at: "2026-10-20T01:00:00Z",
    extraction_triggered: false,
  })),
  resumeConversation: vi.fn(async (): Promise<ChatResume> => ({
    ...row(),
    resumed_from: source,
    messages: history,
  })),
});

describe("CLI resume（#31）", () => {
  it("TTY 中分发恢复 ID/项目为小写，不隐式创建会话", async () => {
    const startChat = vi.fn(async () => 0);
    const fetch = vi.fn();
    expect(
      await runCli(["resume", source.toUpperCase(), "--project", project.toUpperCase()], {
        startChat,
        fetch,
        isTTY: true,
        env: {},
        write: () => {},
      }),
    ).toBe(0);
    expect(startChat).toHaveBeenCalledWith(expect.anything(), project, source);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["resume", source],
    ["resume", "bad", "--project", project],
    ["resume", source, "--project", "bad"],
    ["resume", source, "extra", "--project", project],
    ["resume", source, "--project", project, "--json"],
    ["resume", source, "--project", project, "--probe"],
    ["resume", source, "--project", project, "--limit", "1"],
  ])("非法参数 %# 在网络前拒绝", async (...args) => {
    const fetch = vi.fn(),
      startChat = vi.fn();
    expect(await runCli(args, { fetch, startChat, isTTY: true, env: {}, write: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });
  it("非TTY不恢复、不归档、不创建", async () => {
    const fetch = vi.fn(),
      startChat = vi.fn();
    let text = "";
    expect(
      await runCli(["resume", source, "--project", project], {
        fetch,
        startChat,
        isTTY: false,
        env: {},
        write: (s) => {
          text += s;
        },
      }),
    ).toBe(2);
    expect(text).toContain("交互终端");
    expect(fetch).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });
  it("恢复失败不回显上游异常、不自动重试或新建", async () => {
    const startChat = vi.fn(async () => {
      throw new Error("SECRET-RESPONSE");
    });
    let output = "";
    expect(
      await runCli(["resume", source, "--project", project], {
        startChat,
        isTTY: true,
        env: {},
        write: (s) => {
          output += s;
        },
      }),
    ).toBe(1);
    expect(output).not.toContain("SECRET-RESPONSE");
    expect(startChat).toHaveBeenCalledOnce();
  });
  it("会话层恢复并保留历史，仅向新ID发送；新建和退出沿用生命周期", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    expect(session.resume).toBeTypeOf("function");
    await session.resume(source);
    await session.start();
    expect(session.history).toEqual(history);
    expect(session.id).toBe(fork);
    expect(api.createConversation).not.toHaveBeenCalled();
    await session.send("继续");
    expect(api.sendMessage).toHaveBeenCalledWith(fork, "继续");
    await session.newConversation();
    expect(api.commitConversation).toHaveBeenCalledWith(fork);
    expect(session.history).toEqual([]);
    await session.close();
    expect(api.commitConversation).toHaveBeenLastCalledWith(next);
  });
  it("切换由一次项目POST原子归档当前会话，失败保留当前ID", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    expect(session.resume).toBeTypeOf("function");
    api.resumeConversation.mockRejectedValueOnce(new Error("lost"));
    await expect(session.resume(source)).rejects.toThrow("lost");
    expect(session.id).toBe(next);
    expect(api.commitConversation).not.toHaveBeenCalled();
    await session.resume(source);
    expect(api.resumeConversation).toHaveBeenLastCalledWith(project, source, next);
    expect(session.id).toBe(fork);
  });
  it.each([
    { project_id: next },
    { resumed_from: next },
    { id: source },
    { ended_at: "2026-10-20T01:00:00Z" },
  ])("拒绝错配恢复响应 %#，不偷偷新建", async (override) => {
    const api = fixture();
    api.resumeConversation.mockResolvedValueOnce({
      ...row(),
      resumed_from: source,
      messages: history,
      ...override,
    });
    const session = new ChatSession(api, project);
    expect(session.resume).toBeTypeOf("function");
    await expect(session.resume(source)).rejects.toThrow();
    expect(session.id).toBeNull();
    expect(api.createConversation).not.toHaveBeenCalled();
  });
  it("有会话历史但无跨会话召回，不误标为不记得", () => {
    const text = formatReply({
      message_id: fork,
      answer: "42",
      memories: [],
      abstained: true,
      history_included: true,
    });
    expect(text).not.toContain("不记得");
    expect(text).toContain("会话历史");
    expect(text).toContain("42");
  });
});
