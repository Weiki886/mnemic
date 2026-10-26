import type { ApiClient } from "@mnemic/shared";
import { UsageQuerySchema, UsageReportSchema } from "@mnemic/shared/usage";
import { SessionError } from "./chat-session.js";
import { terminalText } from "./presentation.js";
import type { UsageCommand } from "./slash-commands.js";

export type UsageApi = Pick<ApiClient, "getUsageReport">;
export async function runUsageCommand(
  api: UsageApi,
  projectId: string,
  conversationId: string | null,
  command: Pick<UsageCommand, "current" | "query">,
): Promise<string> {
  if (command.current && !conversationId)
    throw new SessionError("会话尚未创建，无法查询当前会话用量");
  try {
    const project = UsageReportSchema.shape.project_id.parse(projectId),
      conversation = command.current
        ? UsageReportSchema.shape.conversation_id.parse(conversationId)
        : null;
    const query = UsageQuerySchema.parse({
      ...command.query,
      ...(conversation ? { conversation_id: conversation } : {}),
    });
    const r = UsageReportSchema.parse(await api.getUsageReport(project, query));
    if (
      r.project_id !== project ||
      r.conversation_id !== conversation ||
      r.group_by !== query.group_by ||
      (query.from && Date.parse(query.from) !== Date.parse(r.from)) ||
      (query.to && Date.parse(query.to) !== Date.parse(r.to))
    )
      throw new Error("usage scope");
    const t = r.totals,
      cost = t.estimated_cost;
    const lines = [
      `项目 ${project}${conversation ? ` · 会话 ${conversation}` : " · 全项目"}`,
      `UTC ${r.from} → ${r.to}（右端不含）`,
      `调用 ${t.calls} · 成功 ${t.success_calls} · 失败 ${t.error_calls} · 中断 ${t.aborted_calls} · 耗时 ${t.duration_ms} ms`,
      ...(
        [
          "prompt_tokens",
          "completion_tokens",
          "total_tokens",
          "reasoning_tokens",
          "cached_input_tokens",
        ] as const
      ).map((k) => `${k}: 已报告 ${t[k].reported} · 未报告 ${t[k].missing_calls} 次`),
      `${r.currency && cost.known_amount !== null ? `已知部分估价 ${r.currency} ${cost.known_amount}` : "费用未知"} · 已估价 ${cost.priced_calls} 次 · 未估价 ${cost.unpriced_calls} 次（非账单）`,
      ...r.groups.slice(0, 20).map(
        (g) =>
          `${Object.entries(g.key)
            .map(([k, v]) => `${k}=${v ?? "无会话"}`)
            .join(
              " / ",
            )}: ${g.totals.calls} 次 · total已报告 ${g.totals.total_tokens.reported} · 未报告 ${g.totals.total_tokens.missing_calls} 次`,
      ),
    ];
    if (!t.calls) lines.push("该时间范围无模型调用记录");
    if (r.groups.length > 20 || r.groups_truncated)
      lines.push(
        `分组仅显示 ${Math.min(20, r.groups.length)}/${r.groups.length}${r.groups_truncated ? "（服务端分组也已截断）" : ""}，总计仍完整`,
      );
    lines.push("未报告不等于零；embedding 输出 token 可不适用。后台写回可能稍后补齐，请刷新核对。");
    return terminalText(lines.join("\n"), true);
  } catch {
    throw new SessionError(
      "用量读取失败：请检查项目/会话、时间范围、Token 或服务端版本；未自动重试",
    );
  }
}
