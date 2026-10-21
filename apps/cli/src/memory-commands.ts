import { ApiError, type ApiClient } from "@mnemic/shared";
import { BeliefListSchema, ForgetResultSchema, MemoryListQuerySchema } from "@mnemic/shared/memory";
import { SessionError } from "./chat-session.js";
import { terminalText, valueText } from "./presentation.js";
import type { MemoryCommand } from "./slash-commands.js";

export type MemoryApi = Pick<ApiClient, "listBeliefs" | "deleteBelief">;

/** 复用 Web 的项目范围 API；不生成聊天 Evidence、不调用模型，不自动重试。 */
export async function runMemoryCommand(
  api: MemoryApi,
  projectId: string,
  command: MemoryCommand,
): Promise<string> {
  try {
    const project = ForgetResultSchema.shape.id.parse(projectId);
    if (command.name === "forget") {
      const id = ForgetResultSchema.shape.id.parse(command.argument);
      const result = ForgetResultSchema.parse(await api.deleteBelief(project, id));
      if (result.id !== id) throw new Error("wrong deletion confirmation");
      return `软删除已确认：${id}。已退出默认检索，可在 Web 恢复；不是硬删除。`;
    }
    const query = MemoryListQuerySchema.parse(command.query);
    const rows = BeliefListSchema.parse(await api.listBeliefs(project, query));
    if (
      rows.length > query.limit ||
      rows.some(
        (row) =>
          (query.type && row.type !== query.type) ||
          (query.status !== "all" && row.status !== query.status),
      )
    )
      throw new Error("incompatible list filters");
    const lines = [
      `项目 ${project} · 记忆列表（status=${query.status}, type=${query.type ?? "all"}, limit=${query.limit}, offset=${query.offset}）`,
    ];
    if (!rows.length) lines.push("本页暂无记忆");
    for (const row of rows) {
      lines.push(
        `${row.id} [${row.status} / ${row.type ?? "类型未记录"}]`,
        `  ${row.subject} / ${row.attribute} = ${valueText(row.current_value).slice(0, 240)}`,
      );
    }
    lines.push(
      "搜索仅匹配 subject/attribute；翻页请保留筛选条件并调整 --offset。详情可用 mnemic memory ID --project UUID。",
    );
    return terminalText(lines.join("\n"), true);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403)
        throw new SessionError("鉴权被拒绝，请检查 MNEMIC_AUTH_TOKEN");
      if (error.status === 404) throw new SessionError("当前项目中的记忆不存在，请核对 ID");
      if (error.status === 409 && command.name === "forget")
        throw new SessionError("记忆状态冲突：仅 active 可软删除，请先查询当前状态");
    }
    throw new SessionError(
      command.name === "forget"
        ? "软删除结果未确认；请查询列表或 Web 确认，不会自动重试"
        : "记忆列表读取失败、超时或响应不兼容；请检查服务端版本与筛选条件",
    );
  }
}
