import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { ChatApp } from "../src/ChatApp.js";
import { ChatSession } from "../src/chat-session.js";

const project = "01920000-0000-7000-8000-000000000001";
const conv = "01920000-0000-7000-8000-000000000002";
const belief = "01920000-0000-7000-8000-000000000003";
const row = {
  id: conv,
  project_id: project,
  title: null,
  started_at: "2026-10-16T00:00:00Z",
  ended_at: null,
};
const reply = {
  message_id: conv,
  answer: "PostgreSQL",
  abstained: false,
  memories: [
    {
      belief_id: belief,
      belief_version_id: conv,
      subject: "项目",
      attribute: "database",
      value: "PostgreSQL",
    },
  ],
};
const fixture = () => ({
  listApprovalAudits: vi.fn(),
  getConfig: vi.fn(async () => {
    throw new Error("unexpected config");
  }),
  getProjectStatus: vi.fn(async () => {
    throw new Error("unexpected status");
  }),
  updateProvider: vi.fn(async () => {
    throw new Error("unexpected patch");
  }),
  recallBeliefs: vi.fn(async () => {
    throw new Error("unexpected recall");
  }),
  listBeliefs: vi.fn(async () => []),
  deleteBelief: vi.fn(async () => ({ id: belief, status: "deleted" })),
  resumeConversation: vi.fn(async () => ({ ...row, resumed_from: belief, messages: [] })),
  createConversation: vi.fn(async () => row),
  sendMessage: vi.fn(async () => reply),
  commitConversation: vi.fn(async () => ({
    ...row,
    ended_at: "2026-10-16T00:01:00Z",
    extraction_triggered: true,
  })),
});
afterEach(cleanup);

describe("Ink 对话交互", () => {
  it("请求处理和退出期间 Tab 不接受新命令或产生第二次操作", async () => {
    const api = fixture();
    let answer!: (value: typeof reply) => void;
    let committed!: (value: Awaited<ReturnType<typeof api.commitConversation>>) => void;
    api.sendMessage.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    api.commitConversation.mockReturnValueOnce(
      new Promise((resolve) => {
        committed = resolve;
      }),
    );
    const done = vi.fn();
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write("question");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> question"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    view.stdin.write("/");
    view.stdin.write("\t");
    view.stdin.write("\r");
    answer(reply);
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain("处理中"));
    expect(view.lastFrame()).not.toContain("候选：");
    expect(view.lastFrame()).not.toContain("> /");
    expect(api.sendMessage).toHaveBeenCalledOnce();
    view.stdin.write("/exit");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /exit"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.commitConversation).toHaveBeenCalledOnce());
    view.stdin.write("\t");
    view.stdin.write("/help");
    view.stdin.write("\r");
    committed({ ...row, ended_at: "2026-10-16T00:01:00Z", extraction_triggered: true });
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(0));
    expect(api.commitConversation).toHaveBeenCalledOnce();
    expect(api.resumeConversation).not.toHaveBeenCalled();
    expect(view.frames.join("\n")).not.toContain("本地命令帮助");
  });
  it("Tab 补全 /help 并显示本地帮助，不发送或提交", async () => {
    const api = fixture();
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={() => {}} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write("/he");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /he"));
    view.stdin.write("\t");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /help"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("本地命令帮助"));
    expect(view.frames.join("\n")).toContain("/resume UUID");
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.commitConversation).not.toHaveBeenCalled();
    expect(api.resumeConversation).not.toHaveBeenCalled();
    expect(api.createConversation).toHaveBeenCalledOnce();
  });

  it("歧义 Tab 只展示候选，不自动执行；普通文本 Tab 保持不变", async () => {
    const api = fixture();
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={() => {}} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write("/");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /"));
    view.stdin.write("\t");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("候选：/help /new /resume /exit"));
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.commitConversation).not.toHaveBeenCalled();
    view.stdin.write("\u007f");
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain("> /"));
    view.stdin.write("ordinary text");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> ordinary text"));
    expect(view.lastFrame()).not.toContain("候选：");
    view.stdin.write("\t");
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(conv, "ordinary text"));
  });

  it("补全后光标在结尾，非法参数和未知命令均不误发模型或退出", async () => {
    const api = fixture();
    const done = vi.fn();
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write("/ne");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /ne"));
    view.stdin.write("\t");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /new"));
    view.stdin.write("extra");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /new extra"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("用法：/new"));
    expect(view.lastFrame()).toContain("> /new extra");
    // 只删去多余参数，修正为有效 /new，再验证普通消息发送不受影响。
    for (let remaining = "/new extra"; remaining.length > "/new ".length;) {
      view.stdin.write("\u007f");
      remaining = remaining.slice(0, -1);
      await vi.waitFor(() =>
        expect(view.lastFrame()?.split("> ").at(-1)?.trimEnd()).toBe(remaining.trimEnd()),
      );
    }
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.commitConversation).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.createConversation).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain("处理中"));
    view.stdin.write("still usable");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> still usable"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(conv, "still usable"));
  });

  it.each(["/exit now", "/unknown", "/usr/bin/env node with a long explanation"])(
    "错误输入保留供修改：%s",
    async (text) => {
      const api = fixture();
      const done = vi.fn();
      const view = render(
        <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
      );
      await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
      view.stdin.write(text);
      await vi.waitFor(() => expect(view.lastFrame()).toContain(`> ${text}`));
      view.stdin.write("\r");
      await vi.waitFor(() => expect(view.frames.join("\n")).toContain("命令无效"));
      expect(view.lastFrame()).toContain(`> ${text}`);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(api.commitConversation).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
    },
  );

  it("错误命令可退格修改后直接执行", async () => {
    const api = fixture();
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={() => {}} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write("  /help x");
    await vi.waitFor(() => expect(view.lastFrame()).toContain(">   /help x"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("用法：/help"));
    expect(view.lastFrame()).toContain(">   /help x");
    view.stdin.write("\u007f");
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain(">   /help x"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("本地命令帮助"));
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.commitConversation).not.toHaveBeenCalled();
  });
  it("/resume 切换并展示净化的历史与引用，不作为用户消息发送", async () => {
    const target = "01920000-0000-7000-8000-000000000006";
    const fork = "01920000-0000-7000-8000-000000000007";
    const api = {
      ...fixture(),
      resumeConversation: vi.fn(async () => ({
        ...row,
        id: fork,
        resumed_from: target,
        messages: [
          {
            id: target,
            speaker: "assistant" as const,
            raw_text: "昨日回答\u001b[2J\u202e",
            msg_time: row.started_at,
            memories: reply.memories,
          },
        ],
      })),
    };
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={() => {}} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write(`/resume ${target}`);
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`/resume ${target}`));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.resumeConversation).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("昨日回答"));
    const text = view.frames.join("\n");
    expect(text).toContain(belief);
    expect(text).not.toContain("\u001b[2J");
    expect(text).not.toContain("\u202e");
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.commitConversation).not.toHaveBeenCalled();
    expect(api.resumeConversation).toHaveBeenCalledWith(project, target, conv);
    expect(view.lastFrame()).toContain(fork);
  });

  it.each(["", "   "])("空白输入 %j 回车不留下用户块，也不发请求", async (text) => {
    const api = fixture();
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={() => {}} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    if (text) {
      // Ink 裁掉帧末尾空格；先加可见字符再退格，确认空格确实进入 TextInput。
      view.stdin.write(text + "x");
      await vi.waitFor(() => expect(view.lastFrame()).toContain("> " + text + "x"));
      view.stdin.write("\u007f");
      await vi.waitFor(() => expect(view.lastFrame()).not.toContain("> " + text + "x"));
    }
    view.stdin.write("\r");
    // 随后的有效输入作为事件处理屏障，避免对尚未处理的空回车做瞬时断言。
    view.stdin.write("有效消息");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("有效消息"));
    const frames = view.frames.join("\n");
    expect(frames).not.toMatch(/(?:^|\n)你(?:\n|$)/);
    expect(frames).not.toContain("消息不能为空");
    expect(api.sendMessage).not.toHaveBeenCalled();
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
  });

  it("Enter 发送、显示引用，新会话提交再创建，退出提交", async () => {
    const api = fixture();
    const done = vi.fn();
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={done} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write("数据库是什么？");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("数据库是什么？"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain(belief));
    expect(api.sendMessage).toHaveBeenCalledWith(conv, "数据库是什么？");
    view.stdin.write("/new");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /new"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.createConversation).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain("处理中"));
    view.stdin.write("/exit");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("> /exit"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(0));
    expect(api.commitConversation).toHaveBeenCalledTimes(2);
  });

  it("连续 Enter 只发一次；拒答与错误均明确且不泄露原始异常", async () => {
    const api = fixture();
    let resolve!: (r: typeof reply) => void;
    api.sendMessage.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = render(
      <ChatApp session={new ChatSession(api, project)} memoryApi={api} onDone={() => {}} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain(conv));
    view.stdin.write("unknown");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("unknown"));
    view.stdin.write("\r");
    view.stdin.write("\r");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    resolve({ ...reply, abstained: true, memories: [] });
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("不记得"));
    api.sendMessage.mockRejectedValueOnce(new Error("sk-secret-model-response"));
    view.stdin.write("again");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("again"));
    view.stdin.write("\r");
    await vi.waitFor(() => expect(view.frames.join("\n")).toContain("不会自动重试"));
    expect(view.frames.join("\n")).not.toContain("sk-secret-model-response");
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });
});
