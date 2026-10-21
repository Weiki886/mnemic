import { ChatConversationSchema } from "@mnemic/shared/chat";

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
] as const;

type CommandName = (typeof SLASH_COMMANDS)[number]["name"];
type ChatInput =
  | { kind: "empty" }
  | { kind: "message"; text: string }
  | { kind: "command"; name: Exclude<CommandName, "resume"> }
  | { kind: "command"; name: "resume"; argument: string }
  | { kind: "error"; message: string };

export function parseChatInput(text: string): ChatInput {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "message", text };
  const [token, ...args] = trimmed.split(/\s+/);
  const command = SLASH_COMMANDS.find((entry) => `/${entry.name}` === token);
  if (!command) return { kind: "error", message: "未知斜杠命令；输入 /help 查看已支持命令。" };
  if (command.name === "resume") {
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
