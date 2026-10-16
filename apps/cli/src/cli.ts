import { parseArgs } from "node:util";
import { ApiError, createApiClient, type DoctorReport } from "@mnemic/shared";
import { DoctorReportSchema } from "@mnemic/shared/doctor";

const HELP = `mnemic doctor [--server URL] [--probe] [--json]

读取服务端配置并检查连接、鉴权状态、数据库和模型槽位。
--probe  实际调用三个模型槽位，可能计费；默认不调用模型。
--json   输出 JSON 诊断报告。
环境：MNEMIC_SERVER_URL（默认 http://localhost:3000）、MNEMIC_AUTH_TOKEN。
退出码：0 未检测到错误（可能有 SKIP），1 诊断/网络错误，2 参数错误。
`;

interface CliOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  write?: (text: string) => void;
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

// Provider 名称/诊断内容是服务端数据，不能让控制字符操作用户终端。
function terminalText(text: string): string {
  return text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ");
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
  let invalid: "arguments" | "command" | "server" = "arguments";
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        server: { type: "string" },
        probe: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (parsed.values.help || args.length === 0) {
      write(HELP);
      return 0;
    }
    invalid = "command";
    if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "doctor")
      throw new Error("command");
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
  } catch {
    const detail = {
      arguments: "参数无效，请使用 --help 查看支持的选项。",
      command: "命令无效，目前仅支持 doctor；请使用 --help 查看用法。",
      server: "服务地址无效：须为不含凭据、查询或片段的 HTTP(S) URL。",
    }[invalid];
    write(detail + "\n" + HELP);
    return 2;
  }
  const api = createApiClient({
    baseUrl: server,
    timeoutMs: 25_000,
    ...(env.MNEMIC_AUTH_TOKEN ? { token: env.MNEMIC_AUTH_TOKEN } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
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
