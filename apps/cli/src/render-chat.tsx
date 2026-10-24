import { render } from "ink";
import type { ApiClient } from "@mnemic/shared";
import { ChatApp } from "./ChatApp.js";
import { ChatSession } from "./chat-session.js";
import { ApprovalController } from "./approval-controller.js";
import type { ChatApprovalOptions } from "./cli.js";

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
    return code;
  } finally {
    approval.dispose();
    instance.cleanup();
  }
}
