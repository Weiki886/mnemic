import { parseArgs } from "node:util";
import { ApiError, createApiClient, type ApiClient, type DoctorReport } from "@mnemic/shared";
import { DoctorReportSchema } from "@mnemic/shared/doctor";
import { terminalText, formatMemory, chatFailure } from "./presentation.js";
import { runSessions } from "./sessions.js";
import { resolve } from "node:path";
import { ApprovalModeSchema, ApprovalPathSchema } from "@mnemic/shared/approval";

export interface ChatApprovalOptions {
  mode: "read-only" | "confirm" | "auto";
  root: string;
}

const HELP = `mnemic doctor [--server URL] [--probe] [--json]
mnemic chat --project UUID [--server URL] [--approval-mode read-only|confirm|auto] [--root PATH]
mnemic resume ID --project UUID [--server URL] [--approval-mode read-only|confirm|auto] [--root PATH]
mnemic memory ID --project UUID [--server URL] [--json]
mnemic sessions --project UUID [--limit N] [--offset N] [--server URL] [--json]

读取服务端配置并检查连接、鉴权状态、数据库和模型槽位。
chat：实时流式对话；ESC/Ctrl+C 在生成中请求中断、保留上下文，空闲时 Ctrl+C 或 /exit 提交退出。
/new 提交后新建；取消不撤销已发生的模型费用，不自动重试。
文件/命令审批默认 read-only，项目根默认当前目录；/permissions 切换、列出或撤销授权。
仅为未来 Tools 的审批框架；聊天、记忆管理和配置命令不受此文件权限模式控制。
resume：创建续聊会话、引用历史，旧会话归档只读；/resume UUID 可切换。归档可能触发待处理消息提取，可能计费。
memory：只读查看当前值与来源。
sessions：只读当前项目的会话列表，不恢复会话、不调用模型；默认 limit=50、offset=0。
--probe  实际调用三个模型槽位，可能计费；默认不调用模型。
--json   输出 JSON（doctor 诊断、memory 详情或 sessions 分页列表）。
环境：MNEMIC_SERVER_URL（默认 http://localhost:3000）、MNEMIC_AUTH_TOKEN。
退出码：0 未检测到错误（可能有 SKIP），1 诊断/网络错误，2 参数错误。
`;

interface CliOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  write?: (text: string) => void;
  isTTY?: boolean;
  startChat?: (
    api: ApiClient,
    projectId: string,
    resumeId?: string,
    approval?: ChatApprovalOptions,
  ) => Promise<number>;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function pageNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("pagination");
  return value;
}

/** 输出时不使用网络异常正文，避免把认证响应或上游密钥带到终端。 */
function requestFailure(error: unknown, stage: "连接" | "诊断"): string {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return "鉴权被拒绝，请检查 MNEMIC_AUTH_TOKEN 与服务端权限";
  }
  return stage === "连接"
    ? "健康检查失败、连接中断或超时，请检查服务端地址和进程"
    : "诊断请求失败、超时或响应不兼容，请检查服务端版本与配置";
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const env = options.env ?? process.env;
  let server: string;
  let probe: boolean;
  let json: boolean;
  let command: "doctor" | "chat" | "resume" | "memory" | "sessions";
  let limit = 50;
  let offset = 0;
  let projectId: string | undefined;
  let resourceId: string | undefined;
  let approval: ChatApprovalOptions | undefined;
  let invalid: "arguments" | "command" | "server" | "project" | "limit" | "offset" = "arguments";
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        server: { type: "string" },
        probe: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        project: { type: "string" },
        limit: { type: "string" },
        offset: { type: "string" },
        "approval-mode": { type: "string" },
        root: { type: "string" },
      },
    });
    if (parsed.values.help || args.length === 0) {
      write(HELP);
      return 0;
    }
    invalid = "command";
    const action = parsed.positionals[0];
    if (
      action !== "doctor" &&
      action !== "chat" &&
      action !== "resume" &&
      action !== "memory" &&
      action !== "sessions"
    )
      throw new Error("command");
    command = action;
    if (parsed.positionals.length !== (command === "memory" || command === "resume" ? 2 : 1))
      throw new Error("command");
    invalid = "arguments";
    if (
      (command !== "doctor" && parsed.values.probe !== undefined) ||
      ((command === "chat" || command === "resume") && parsed.values.json !== undefined) ||
      (command === "doctor" && parsed.values.project !== undefined) ||
      (command !== "chat" &&
        command !== "resume" &&
        (parsed.values["approval-mode"] !== undefined || parsed.values.root !== undefined)) ||
      (command !== "sessions" &&
        (parsed.values.limit !== undefined || parsed.values.offset !== undefined))
    )
      throw new Error("flags");
    if (parsed.values["approval-mode"] !== undefined || parsed.values.root !== undefined) {
      approval = {
        mode: ApprovalModeSchema.parse(parsed.values["approval-mode"] ?? "read-only"),
        root: resolve(ApprovalPathSchema.parse(parsed.values.root ?? process.cwd())),
      };
    }
    if (command === "sessions") {
      invalid = "limit";
      limit = pageNumber(parsed.values.limit, 50, 1, 1000);
      invalid = "offset";
      offset = pageNumber(parsed.values.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      invalid = "arguments";
    }
    resourceId = parsed.positionals[1];
    if (resourceId && !UUID.test(resourceId)) throw new Error("resource ID");
    resourceId = resourceId?.toLowerCase();
    if (command !== "doctor") {
      invalid = "project";
      projectId = parsed.values.project;
      if (!projectId || !UUID.test(projectId)) throw new Error("project ID");
      projectId = projectId.toLowerCase();
    }
    invalid = "server";
    const url = new URL(parsed.values.server ?? env.MNEMIC_SERVER_URL ?? "http://localhost:3000");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("server URL");
    }
    server = url.toString().replace(/\/+$/, "");
    probe = parsed.values.probe ?? false;
    json = parsed.values.json ?? false;
  } catch (error) {
    // parseArgs rejects missing or dash-prefixed values before pageNumber runs.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
    ) {
      const flag = /^Option '--(limit|offset)(?: <value>)?'/.exec(error.message)?.[1];
      if (flag === "limit" || flag === "offset") invalid = flag;
    }
    const detail = {
      arguments: "参数无效，请使用 --help 查看支持的选项。",
      command: "命令无效，请使用 doctor、chat、resume、memory 或 sessions；使用 --help 查看用法。",
      server: "服务地址无效：须为不含凭据、查询或片段的 HTTP(S) URL。",
      project: "项目参数无效：请提供 --project UUID，且项目须已存在。",
      limit: "--limit 必须为 1–1000 的整数。",
      offset: "--offset 必须为 0–9007199254740991 的整数。",
    }[invalid];
    write(detail + "\n" + HELP);
    return 2;
  }
  const api = createApiClient({
    baseUrl: server,
    timeoutMs: command === "chat" || command === "resume" ? 120_000 : 25_000,
    ...(env.MNEMIC_AUTH_TOKEN ? { token: env.MNEMIC_AUTH_TOKEN } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (command === "sessions") return runSessions(api, projectId!, { limit, offset, json }, write);
  if (command === "chat" || command === "resume") {
    if (!(options.isTTY ?? process.stdin.isTTY)) {
      write("chat / resume 需要交互终端，请在终端直接运行。\n");
      return 2;
    }
    try {
      const start = options.startChat ?? (await import("./render-chat.js")).startChat;
      if (approval) return await start(api, projectId!, resourceId, approval);
      return command === "resume"
        ? await start(api, projectId!, resourceId!)
        : await start(api, projectId!);
    } catch (error) {
      write(chatFailure(error) + "\n");
      return 1;
    }
  }
  if (command === "memory") {
    try {
      const memory = await api.getBelief(projectId!, resourceId!);
      if (memory.id !== resourceId || memory.project_id !== projectId)
        throw new Error("memory scope");
      write((json ? JSON.stringify(memory) : formatMemory(memory)) + "\n");
      return 0;
    } catch (error) {
      write(chatFailure(error) + "\n");
      return 1;
    }
  }
  let connectivity: { status: "ok" | "error"; detail: string };
  let diagnostics: DoctorReport | null = null;
  let error: string | null = null;
  try {
    const health = await api.health();
    if (health.status !== "ok") throw new Error("health");
    connectivity = { status: "ok", detail: "服务端健康检查通过" };
  } catch (cause) {
    connectivity = { status: "error", detail: requestFailure(cause, "连接") };
  }
  if (connectivity.status === "ok") {
    try {
      diagnostics = DoctorReportSchema.parse(await api.doctor(probe));
    } catch (cause) {
      error = requestFailure(cause, "诊断");
    }
  }
  const ok = connectivity.status === "ok" && diagnostics?.ok === true;
  if (json) {
    write(JSON.stringify({ ok, connectivity, diagnostics, error }) + "\n");
  } else {
    write(`[${connectivity.status.toUpperCase()}] connectivity: ${connectivity.detail}\n`);
    for (const check of diagnostics?.checks ?? []) {
      const model = check.model ? ` (${check.provider ?? ""}/${check.model})` : "";
      write(
        terminalText(
          `[${check.status === "skipped" ? "SKIP" : check.status.toUpperCase()}] ${check.name}${model}: ${check.detail}`,
        ) + "\n",
      );
    }
    if (error) write(`[ERROR] doctor: ${error}\n`);
  }
  return ok ? 0 : 1;
}
