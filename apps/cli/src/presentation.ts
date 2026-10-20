import { setTimeout as delay } from "node:timers/promises";
import { ApiError, type ChatReply, type BeliefDetail } from "@mnemic/shared";
import { SessionError } from "./chat-session.js";

export function terminalText(text: string, multiline = false): string {
  return text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, (char) =>
    multiline && char === "\n" ? "\n" : " ",
  );
}
function valueText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "未提供");
}

export function formatReply(reply: ChatReply, answer = reply.answer): string {
  const lines = [
    reply.abstained
      ? reply.history_included
        ? "未召回跨会话记忆；已提供会话历史。"
        : "不记得：没有足够的相关记忆。"
      : "",
    terminalText(answer, true),
  ];
  for (const memory of reply.memories) {
    lines.push(terminalText(`引用 ${memory.belief_id} / 版本 ${memory.belief_version_id}`));
    lines.push(
      terminalText(
        `  ${memory.subject} / ${memory.attribute} = ${valueText(memory.value).slice(0, 240)}`,
      ),
    );
  }
  return lines.filter(Boolean).join("\n");
}
export function formatMemory(memory: BeliefDetail): string {
  const lines = [
    terminalText(`记忆 ${memory.id} [${memory.status}]`),
    terminalText(`${memory.subject} / ${memory.attribute}`),
    "当前值：" + terminalText(valueText(memory.current_value), true),
  ];
  for (const version of memory.versions) {
    lines.push(
      terminalText(
        `版本 ${version.id} · 记录于 ${version.recorded_from}${version.recorded_to ? "（历史）" : ""}`,
      ),
    );
    lines.push(
      version.source
        ? terminalText(
            `来源会话 ${version.source.conversation_id} · 消息 ${version.source.message_id} · Observation ${version.source.observation_id}`,
          )
        : "来源未记录",
    );
  }
  return lines.join("\n");
}
export function chatFailure(error: unknown): string {
  if (error instanceof SessionError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "鉴权被拒绝，请检查 MNEMIC_AUTH_TOKEN";
    if (error.status === 404) return "项目、会话或记忆不存在，请核对 ID";
    if (error.status === 409) return "会话已归档或状态冲突，请核对历史引用后使用 resume 或新建会话";
  }
  return "请求失败、超时或响应不兼容；服务端可能已收到消息，不会自动重试";
}
/** HTTP 完整回答到达后客户端分段显示；不是 SSE/token 流（#33）。 */
export async function renderAnswerChunks(
  answer: string,
  render: (text: string) => void,
): Promise<void> {
  const chars = Array.from(terminalText(answer, true));
  for (let end = 240; end < chars.length + 240; end += 240) {
    render(chars.slice(0, end).join(""));
    if (end < chars.length) await delay(15);
  }
}
