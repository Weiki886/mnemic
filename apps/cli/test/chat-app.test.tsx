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
  it.each(["", "   "])("空白输入 %j 回车不留下用户块，也不发请求", async (text) => {
    const api = fixture();
    const view = render(<ChatApp session={new ChatSession(api, project)} onDone={() => {}} />);
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
    const view = render(<ChatApp session={new ChatSession(api, project)} onDone={done} />);
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
    const view = render(<ChatApp session={new ChatSession(api, project)} onDone={() => {}} />);
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
