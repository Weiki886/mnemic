import { render } from "ink";
import type { ApiClient } from "@mnemic/shared";
import { ChatApp } from "./ChatApp.js";
import { ChatSession } from "./chat-session.js";

export async function startChat(
  api: ApiClient,
  projectId: string,
  resumeId?: string,
): Promise<number> {
  let code = 0;
  const session = new ChatSession(api, projectId);
  // Fail before rendering: no fallback creation or implicit retry on a lost resume response.
  if (resumeId) await session.resume(resumeId);
  const instance = render(
    <ChatApp
      session={session}
      memoryApi={api}
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
    instance.cleanup();
  }
}
