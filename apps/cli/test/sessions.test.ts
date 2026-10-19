import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

const project = "a1920000-0000-7000-8000-000000000001";
const session = {
  id: "01920000-0000-7000-8000-000000000002",
  title: "数据库选型",
  started_at: "2026-10-19T00:00:00.000Z",
  ended_at: null,
  message_count: 2,
};
function fixture(body: unknown = [session], status = 200) {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  let output = "";
  const options = {
    fetch,
    env: {
      MNEMIC_AUTH_TOKEN: "test-token-secret",
      MNEMIC_SERVER_URL: "https://server.example/api/",
    },
    isTTY: false,
    write: (text: string) => {
      output += text;
    },
  };
  return { fetch, options, output: () => output };
}

describe("CLI sessions（#31 拆分 1/2）", () => {
  it("经 shared client 单次只读请求，带项目分页、Bearer 和超时，非 TTY 可用", async () => {
    const f = fixture();
    expect(await runCli(["sessions", "--project", project.toUpperCase()], f.options)).toBe(0);
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe(
      `https://server.example/api/projects/${project}/conversations?limit=50&offset=0`,
    );
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token-secret");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    for (const text of [
      project,
      session.id,
      session.title,
      session.started_at,
      "2 条消息",
      "进行中",
      "limit=50",
      "offset=0",
    ])
      expect(f.output()).toContain(text);
    expect(f.output()).not.toContain("test-token-secret");
  });

  it("显式服务地址覆盖环境，JSON 单对象携带项目、分页与会话数据", async () => {
    const rows = [
      { ...session, title: null, ended_at: "2026-10-19T01:00:00.000Z", message_count: 0 },
    ];
    const f = fixture(rows);
    expect(
      await runCli(
        [
          "sessions",
          "--project",
          project,
          "--limit",
          "1",
          "--offset",
          "7",
          "--server",
          "http://127.0.0.1:9999",
          "--json",
        ],
        f.options,
      ),
    ).toBe(0);
    expect(f.fetch.mock.calls[0]![0]).toBe(
      `http://127.0.0.1:9999/projects/${project}/conversations?limit=1&offset=7`,
    );
    expect(JSON.parse(f.output())).toEqual({
      project_id: project,
      limit: 1,
      offset: 7,
      sessions: rows,
    });
  });

  it("人类输出展示已提交、空标题和结束时间，剥离终端控制字符", async () => {
    const f = fixture([
      { ...session, title: "title\u001b[2J\n\r\u202e\u2066end", ended_at: session.started_at },
      { ...session, title: null },
    ]);
    expect(await runCli(["sessions", "--project", project], f.options)).toBe(0);
    expect(f.output()).toContain("已提交");
    expect(f.output()).toContain("结束：" + session.started_at);
    expect(f.output()).toContain("（无标题）");
    for (const char of ["\u001b", "\r", "\u202e", "\u2066"]) expect(f.output()).not.toContain(char);
    expect(f.output()).not.toContain("title\u001b[2J\n");
  });

  it.each([false, true])("空列表不创建会话，JSON=%s", async (json) => {
    const f = fixture([]);
    expect(
      await runCli(["sessions", "--project", project, ...(json ? ["--json"] : [])], f.options),
    ).toBe(0);
    if (json) expect(JSON.parse(f.output()).sessions).toEqual([]);
    else expect(f.output()).toContain("本页暂无会话");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["sessions"],
    ["sessions", "--project", "../bad"],
    ["sessions", "extra", "--project", project],
    ["sessions", "--project", project, "--probe"],
    ["sessions", "--project", project + "\n"],
    ...["0", "1001", "1.5", "1e2", "", "-1"].map((value) => [
      "sessions",
      "--project",
      project,
      "--limit",
      value,
    ]),
    ...["-1", "1.5", "1e2", "", "9007199254740992"].map((value) => [
      "sessions",
      "--project",
      project,
      "--offset",
      value,
    ]),
    ["doctor", "--limit", "1"],
    ["chat", "--project", project, "--offset", "1"],
    ["memory", session.id, "--project", project, "--limit", "1"],
    ["sessions", "--project", project, "--server", "https://user:secret@example.com"],
  ])("非法参数（case %#）不请求网络", async (...args) => {
    const f = fixture();
    expect(await runCli(args, f.options)).toBe(2);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.output()).not.toContain("user:secret");
  });

  it.each([401, 403])("拒绝 %s 提示 Token，不回显上游错误正文", async (status) => {
    const f = fixture({ detail: "upstream-secret" }, status);
    expect(await runCli(["sessions", "--project", project], f.options)).toBe(1);
    expect(f.output()).toContain("MNEMIC_AUTH_TOKEN");
    expect(f.output()).not.toContain("upstream-secret");
  });

  it.each(
    [
      {},
      [{ ...session, message_count: "2" }],
      [{ ...session, started_at: "invalid" }],
      [session, { ...session, id: "bad" }],
    ].map((body) => ({ body })),
  )("响应不兼容（case $#）整页拒绝，不输出部分记录", async ({ body }) => {
    const f = fixture(body);
    expect(await runCli(["sessions", "--project", project, "--json"], f.options)).toBe(1);
    expect(f.output()).toContain("会话列表");
    expect(f.output()).not.toContain(session.title);
    expect(f.output()).not.toContain(session.id);
  });

  it("服务端越过请求单页上限时拒绝响应", async () => {
    const f = fixture([session, session]);
    expect(await runCli(["sessions", "--project", project, "--limit", "1"], f.options)).toBe(1);
    expect(f.output()).not.toContain(session.title);
  });

  it("网络失败不回显原始异常，也不使用写入可能已发生的提示", async () => {
    const f = fixture();
    f.fetch.mockRejectedValueOnce(new Error("network-secret"));
    expect(await runCli(["sessions", "--project", project], f.options)).toBe(1);
    expect(f.output()).toContain("会话列表");
    expect(f.output()).not.toContain("network-secret");
    expect(f.output()).not.toContain("已收到消息");
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
