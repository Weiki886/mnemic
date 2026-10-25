import type { ApiClient } from "@mnemic/shared";
import { ApprovalContextSchema } from "@mnemic/shared/approval";
import {
  ApprovalAuditEventSchema,
  ApprovalAuditRecordSchema,
  ApprovalAuditPageSchema,
  ApprovalAuditQuerySchema,
  type ApprovalAuditQuery,
  type ApprovalAuditSink,
} from "@mnemic/shared/approval-audit";
export type ApprovalHistoryApi = Pick<ApiClient, "listApprovalAudits">;
export function createApprovalAuditSink(
  api: Pick<ApiClient, "recordApproval">,
  projectId: string,
): ApprovalAuditSink {
  const project = ApprovalContextSchema.shape.project_id.parse(projectId);
  return async (input) => {
    const event = ApprovalAuditEventSchema.parse(input);
    if (event.project_id !== project) throw new Error("审批审计项目不匹配");
    const receipt = ApprovalAuditRecordSchema.parse(await api.recordApproval(project, event));
    if (JSON.stringify(receipt.event) !== JSON.stringify(event))
      throw new Error("审批审计回执不匹配");
  };
}
export async function runApprovalHistory(
  api: ApprovalHistoryApi,
  projectId: string,
  input: Partial<ApprovalAuditQuery> = {},
): Promise<string> {
  const project = ApprovalContextSchema.shape.project_id.parse(projectId),
    query = ApprovalAuditQuerySchema.parse(input);
  const page = ApprovalAuditPageSchema.parse(await api.listApprovalAudits(project, query));
  if (
    page.limit !== query.limit ||
    page.offset !== query.offset ||
    page.items.length > query.limit ||
    page.items.some((row) => row.event.project_id !== project)
  )
    throw new Error("审批审计分页或项目不匹配");
  return [
    "审批审计（客户端声明，非执行记录）",
    `limit=${page.limit} offset=${page.offset}`,
    ...(page.items.length
      ? page.items.map(
          (row) =>
            `${row.event.event_id} request=${row.event.request_id}\n${row.recorded_at} ${row.event.decision} ${row.event.operation ?? "invalid"} ${row.event.reason}${row.event.scope ? ` ${row.event.scope}` : ""}\ntarget=${row.event.target_hash ?? "none"} (${row.event.target_basis})`,
        )
      : ["暂无审批记录"]),
  ].join("\n");
}
