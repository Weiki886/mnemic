import { ChatConversationSchema } from "@mnemic/shared/chat";
import {
  MemoryListQuerySchema,
  RecallRequestSchema,
  type MemoryListQuery,
} from "@mnemic/shared/memory";
import { parseArgs } from "node:util";
import { ProviderPatchSchema, type ProviderPatch } from "@mnemic/shared/management";

/** 只注册已经实现的命令；解析、帮助与补全共用，不从网络或历史加载命令。 */
export const SLASH_COMMANDS = [
  { name: "help", usage: "/help", description: "查看本地命令帮助，不调用模型" },
  { name: "new", usage: "/new", description: "提交当前会话并新建；后台提取可能计费" },
  {
    name: "resume",
    usage: "/resume UUID",
    description: "引用目标历史创建续聊会话；归档可能触发计费提取",
  },
  { name: "exit", usage: "/exit", description: "等待当前请求后提交退出；后台提取可能计费" },
  {
    name: "memory",
    usage: "/memory [--type TYPE] [--status STATUS] [--limit N] [--offset N] [搜索词...]",
    description:
      "查看当前项目记忆；类型 fact/preference/decision/progress，状态 active/deleted/retracted/all，默认 active、20 条",
  },
  {
    name: "forget",
    usage: "/forget UUID",
    description: "软删除当前项目的 active 记忆，可在 Web 恢复；不调用模型",
  },
  {
    name: "recall",
    usage: "/recall 查询内容",
    description:
      "手动召回并显示 trace/分数；embedding 可能计费，失败时可降级为关键词，不生成聊天回答",
  },
  {
    name: "status",
    usage: "/status",
    description: "当前会话、项目精确记忆计数及生效模型配置；不探测模型",
  },
  {
    name: "config",
    usage: "/config [set PROVIDER_UUID FIELD VALUE]",
    description:
      "全局配置查看/修改已有 Provider；FIELD=name/base_url/protocol/chat/extraction，不接收密钥，embedding 需 REEMBED",
  },
] as const;

type CommandName = (typeof SLASH_COMMANDS)[number]["name"];
export type MemoryCommand =
  | { kind: "command"; name: "memory"; query: MemoryListQuery }
  | { kind: "command"; name: "forget"; argument: string };
export type ManagementCommand =
  | { kind: "command"; name: "status" }
  | { kind: "command"; name: "config"; action: "show" }
  | { kind: "command"; name: "config"; action: "set"; id: string; patch: ProviderPatch };
type ChatInput =
  | { kind: "empty" }
  | { kind: "message"; text: string }
  | {
      kind: "command";
      name: Exclude<CommandName, "resume" | "memory" | "forget" | "recall" | "status" | "config">;
    }
  | { kind: "command"; name: "resume"; argument: string }
  | MemoryCommand
  | ManagementCommand
  | { kind: "command"; name: "recall"; query: string }
  | { kind: "error"; message: string };

export function parseChatInput(text: string): ChatInput {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "message", text };
  const [token, ...args] = trimmed.split(/\s+/);
  const command = SLASH_COMMANDS.find((entry) => `/${entry.name}` === token);
  if (!command) return { kind: "error", message: "未知斜杠命令；输入 /help 查看已支持命令。" };
  if (command.name === "status")
    return args.length
      ? { kind: "error", message: "用法：/status" }
      : { kind: "command", name: "status" };
  if (command.name === "config") {
    if (!args.length) return { kind: "command", name: "config", action: "show" };
    const [action, rawId, field, ...values] = args;
    const id = ChatConversationSchema.shape.id.safeParse(rawId);
    const value = values.join(" ");
    const patch = ProviderPatchSchema.safeParse(
      field === "chat" || field === "extraction"
        ? { models: { [field]: value } }
        : { [field ?? ""]: value },
    );
    if (action !== "set" || !id.success || !patch.success || !values.length)
      return {
        kind: "error",
        message:
          "用法：/config set PROVIDER_UUID FIELD VALUE；全局修改 name/base_url/protocol/chat/extraction，不接受密钥或 embedding 切换。",
      };
    return {
      kind: "command",
      name: "config",
      action: "set",
      id: id.data.toLowerCase(),
      patch: patch.data,
    };
  }
  if (command.name === "recall") {
    const parsed = RecallRequestSchema.safeParse({ query: trimmed.slice(token!.length) });
    return parsed.success
      ? { kind: "command", name: "recall", query: parsed.data.query }
      : {
          kind: "error",
          message: "用法：/recall 查询内容；须为 1–1000 字符，embedding 可能计费。",
        };
  }
  if (command.name === "memory") {
    try {
      const parsed = parseArgs({
        args,
        allowPositionals: true,
        tokens: true,
        options: {
          type: { type: "string" },
          status: { type: "string" },
          limit: { type: "string" },
          offset: { type: "string" },
        },
      });
      const seen = new Set<string>();
      for (const token of parsed.tokens) {
        if (token.kind !== "option") continue;
        if (seen.has(token.name)) throw new Error("duplicate option");
        seen.add(token.name);
      }
      for (const raw of [parsed.values.limit, parsed.values.offset]) {
        if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error("integer required");
      }
      const q = parsed.positionals.join(" ");
      const query = MemoryListQuerySchema.parse({ ...parsed.values, ...(q ? { q } : {}) });
      return { kind: "command", name: "memory", query };
    } catch {
      return {
        kind: "error",
        message: `用法：${command.usage}；limit 1–1000，offset 为非负安全整数，搜索词最多 200 字符。搜索词以 - 开头时先加 --，例如 /memory -- -db。`,
      };
    }
  }
  if (command.name === "resume" || command.name === "forget") {
    const id = ChatConversationSchema.shape.id.safeParse(args[0]);
    if (args.length !== 1 || !id.success)
      return { kind: "error", message: `用法：${command.usage}` };
    return { kind: "command", name: command.name, argument: id.data.toLowerCase() };
  }
  if (args.length) return { kind: "error", message: `用法：${command.usage}` };
  return { kind: "command", name: command.name };
}

/** 仅补全整个命令名；候选不执行，也不推测 UUID/文件路径/参数。 */
export function completeSlash(text: string): { value: string; candidates: string[] } {
  const command = text.trimStart();
  if (!command.startsWith("/") || /[^a-z]/.test(command.slice(1)))
    return { value: text, candidates: [] };
  const prefix = text.slice(0, text.length - command.length);
  const candidates = SLASH_COMMANDS.map((entry) => `/${entry.name}`).filter((name) =>
    name.startsWith(command),
  );
  return { value: candidates.length === 1 ? `${prefix}${candidates[0]} ` : text, candidates };
}

export function slashHelp(): string {
  return (
    SLASH_COMMANDS.map((entry) => `${entry.usage} — ${entry.description}`).join("\n") +
    "\nTab 补全命令名；多个候选时只提示，不自动执行。未知命令不会发送给模型。"
  );
}
