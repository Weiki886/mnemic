import { ApiError, type ApiClient } from "@mnemic/shared";
import { ConversationListSchema } from "@mnemic/shared/chat";
import { chatFailure, terminalText } from "./presentation.js";

/** 只读服务端列表；不创建/恢复/提交会话，也不调用模型。 */
export async function runSessions(
  api: ApiClient,
  projectId: string,
  page: { limit: number; offset: number; json: boolean },
  write: (text: string) => void,
): Promise<number> {
  try {
    const sessions = ConversationListSchema.parse(
      await api.listConversations(projectId, { limit: page.limit, offset: page.offset }),
    );
    if (sessions.length > page.limit) throw new Error("page size exceeded");
    if (page.json) {
      write(
        JSON.stringify({
          project_id: projectId,
          limit: page.limit,
          offset: page.offset,
          sessions,
        }) + "\n",
      );
    } else {
      const lines = [`项目 ${projectId} · 会话列表（limit=${page.limit}, offset=${page.offset}）`];
      if (sessions.length === 0) lines.push("本页暂无会话");
      for (const session of sessions) {
        lines.push(
          `${session.id} [${session.ended_at ? "已提交" : "进行中"}]`,
          "  标题：" + terminalText(session.title ?? "（无标题）"),
          `  开始：${session.started_at} · 结束：${session.ended_at ?? "—"} · ${session.history_error ? "历史不可用 · 消息数未知" : `${session.message_count} 条消息`}`,
        );
      }
      lines.push("按开始时间升序；翻页请调整 --limit / --offset。本命令不会恢复会话。");
      write(lines.join("\n") + "\n");
    }
    return 0;
  } catch (error) {
    write(
      (error instanceof ApiError && (error.status === 401 || error.status === 403)
        ? chatFailure(error)
        : "会话列表读取失败、超时或响应不兼容；请检查项目、服务地址与版本。") + "\n",
    );
    return 1;
  }
}
