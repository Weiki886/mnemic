import { render } from "ink";
import type { ApiClient } from "@mnemic/shared";
import { ChatApp } from "./ChatApp.js";
import { ChatSession } from "./chat-session.js";
import { ApprovalController } from "./approval-controller.js";
import type { ChatApprovalOptions } from "./cli.js";
import { createApprovalAuditSink } from "./approval-audit.js";

export async function startChat(
  api: ApiClient,
  projectId: string,
  resumeId?: string,
  options?: ChatApprovalOptions,
): Promise<number> {
  let code = 0;
  const session = new ChatSession(api, projectId);
  const approval = await ApprovalController.create({
    projectId,
    root: options?.root ?? process.cwd(),
    ...(options ? { mode: options.mode } : {}),
    audit: createApprovalAuditSink(api, projectId),
  });
  // Fail before rendering: no fallback creation or implicit retry on a lost resume response.
  if (resumeId) await session.resume(resumeId);
  const instance = render(
    <ChatApp
      session={session}
      memoryApi={api}
      approval={approval}
      onDone={(result) => {
        code = result;
      }}
    />,
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    approval.dispose();
    await approval.drain();
    instance.cleanup();
  }
  if (approval.auditFailed) {
    process.stderr.write("有审批审计写入未确认；相关请求未获授权，请检查服务端及本地授权记录。\n");
    return 1;
  }
  return code;
}
