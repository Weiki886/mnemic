import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/chat-session.js";
import { formatReply, formatMemory } from "../src/presentation.js";
import { ApiError, type BeliefDetail } from "@mnemic/shared";

const project = "01920000-0000-7000-8000-000000000001";
const c1 = "01920000-0000-7000-8000-000000000002";
const c2 = "01920000-0000-7000-8000-000000000003";
const belief = "01920000-0000-7000-8000-000000000004";
const version = "01920000-0000-7000-8000-000000000005";
const conversation = (id = c1) => ({
  id,
  project_id: project,
  title: null,
  started_at: "2026-10-16T00:00:00.000Z",
  ended_at: null,
});
const answer = (value = "PostgreSQL") => ({
  message_id: c2,
  answer: `数据库使用 ${value}`,
  abstained: false,
  memories: [
    { belief_id: belief, belief_version_id: version, subject: "项目", attribute: "数据库", value },
  ],
});
const fixture = () => ({
  getConversation: vi.fn(async () => ({
    ...conversation(),
    ended_at: "2026-10-16T01:00:00.000Z",
    messages: [],
  })),
  resumeConversation: vi.fn(async () => ({ ...conversation(), resumed_from: c2, messages: [] })),
  createConversation: vi.fn(async () => conversation()),
  sendMessage: vi.fn(async () => answer()),
  commitConversation: vi.fn(async (id: string) => ({
    ...conversation(id),
    ended_at: "2026-10-16T01:00:00.000Z",
    extraction_triggered: false,
  })),
});

describe("CLI 对话会话（#19 2/2）", () => {
  it("会话层按 UUID 语义比较大小写，避免已创建的会话失联", async () => {
    const api = fixture();
    const upper = "A1920000-0000-7000-8000-000000000001";
    api.createConversation.mockResolvedValueOnce({
      ...conversation(),
      project_id: upper.toLowerCase(),
    });
    const session = new ChatSession(api, upper);
    await expect(session.start()).resolves.toMatchObject({ id: c1 });
    expect(api.createConversation).toHaveBeenCalledWith(upper.toLowerCase());
  });
  it("创建一次并发送原始文本，回答保留引用与更新后的值", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    await session.start();
    expect((await session.send("  数据库用 PostgreSQL  ")).memories[0]!.value).toBe("PostgreSQL");
    api.sendMessage.mockResolvedValueOnce(answer("MySQL"));
    expect((await session.send("改成 MySQL")).answer).toContain("MySQL");
    expect(api.createConversation).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, project, c1, "  数据库用 PostgreSQL  ");
  });

  it("新会话先提交旧会话；失败不偷偷换会话或自动重试", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    api.commitConversation.mockRejectedValueOnce(new Error("network secret"));
    await expect(session.newConversation()).rejects.toThrow();
    expect(api.createConversation).toHaveBeenCalledOnce();
    expect(session.id).toBe(c1);
    api.createConversation.mockResolvedValueOnce(conversation(c2));
    await session.newConversation();
    await session.send("database？");
    expect(api.commitConversation).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenCalledWith(project, c2, "database？");
  });

  it("提交响应丢失后，用户再次新建收到 409 仍能进入新会话", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    api.commitConversation.mockRejectedValueOnce(new Error("lost response"));
    await expect(session.newConversation()).rejects.toThrow("lost response");
    expect(session.id).toBe(c1);
    expect(api.createConversation).toHaveBeenCalledOnce();
    api.commitConversation.mockRejectedValueOnce(new ApiError(409, "CONFLICT", "已提交"));
    api.createConversation.mockResolvedValueOnce(conversation(c2));
    await expect(session.newConversation()).resolves.toMatchObject({ id: c2 });
    await session.send("新会话消息");
    expect(api.sendMessage).toHaveBeenCalledWith(project, c2, "新会话消息");
    expect(api.createConversation).toHaveBeenCalledTimes(2);
    expect(api.commitConversation).toHaveBeenCalledTimes(2);
  });

  it("退出收到已提交 409 也成功，重复退出不重复提交", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    api.commitConversation.mockRejectedValueOnce(new ApiError(409, "CONFLICT", "已提交"));
    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
    expect(api.commitConversation).toHaveBeenCalledOnce();
    await expect(session.send("退出后")).rejects.toThrow();
  });

  it.each([404, 500])("提交 %i 不视为已结束，也不创建新会话", async (status) => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    const error = new ApiError(status, null, "failure");
    api.commitConversation.mockRejectedValueOnce(error);
    await expect(session.newConversation()).rejects.toBe(error);
    expect(session.id).toBe(c1);
    expect(api.createConversation).toHaveBeenCalledOnce();
  });

  it("提交响应为 null 时仍拒绝，不把畸形响应当作已提交", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    api.commitConversation.mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof api.commitConversation>>,
    );
    await expect(session.newConversation()).rejects.toThrow();
    expect(session.id).toBe(c1);
    expect(api.createConversation).toHaveBeenCalledOnce();
  });

  it("发消息收到 409 仍失败，不自动提交或新建", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    const error = new ApiError(409, "CONFLICT", "已提交");
    api.sendMessage.mockRejectedValueOnce(error);
    await expect(session.send("hello")).rejects.toBe(error);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.commitConversation).not.toHaveBeenCalled();
    expect(api.createConversation).toHaveBeenCalledOnce();
  });

  it("并发 Enter 不会重复发消息，退出等待进行中请求并只提交一次", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await session.start();
    let resolve!: (r: ReturnType<typeof answer>) => void;
    api.sendMessage.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = session.send("hello");
    await expect(session.send("duplicate")).rejects.toThrow();
    const close1 = session.close();
    const close2 = session.close();
    expect(api.commitConversation).not.toHaveBeenCalled();
    resolve(answer());
    await pending;
    await Promise.all([close1, close2]);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.commitConversation).toHaveBeenCalledOnce();
    await expect(session.send("after exit")).rejects.toThrow();
  });

  it("空白或超长输入不会创建会话/发送；响应项目不匹配时不会继续写入", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    await expect(session.send("  ")).rejects.toThrow();
    await expect(session.send("x".repeat(8001))).rejects.toThrow();
    expect(api.createConversation).not.toHaveBeenCalled();
    api.createConversation.mockResolvedValueOnce({ ...conversation(), project_id: c2 });
    await expect(session.send("hello")).rejects.toThrow();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("未知或非法回答拒绝展示，并且发送失败不自动重试", async () => {
    const api = fixture();
    const session = new ChatSession(api, project);
    api.sendMessage.mockRejectedValueOnce(new Error("secret failure"));
    await expect(session.send("hello")).rejects.toThrow();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    api.sendMessage.mockResolvedValueOnce({ ...answer(), message_id: "../wrong" });
    await expect(session.send("hello again")).rejects.toThrow();
  });
});

describe("CLI 只读展示", () => {
  it("引用完整 ID 和摘要；abstained 即使模型没有说也明确显示不记得", () => {
    const text = formatReply(answer());
    expect(text).toContain(belief);
    expect(text).toContain(version);
    expect(text).toContain("PostgreSQL");
    expect(formatReply({ ...answer(), abstained: true, memories: [] })).toContain("不记得");
  });

  it("记忆详情显示当前值及会话/消息/Observation 来源，不执行编辑", () => {
    const detail = {
      id: belief,
      subject: "项目",
      attribute: "数据库",
      current_value: "MySQL",
      status: "active",
      versions: [
        {
          id: version,
          recorded_from: "2026-10-16T00:00:00Z",
          recorded_to: null,
          source: { conversation_id: c1, message_id: c2, observation_id: project },
        },
      ],
    } as BeliefDetail;
    const text = formatMemory(detail);
    for (const value of [belief, "MySQL", c1, c2, project]) expect(text).toContain(value);
  });
});
