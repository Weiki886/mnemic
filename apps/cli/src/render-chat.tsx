import { render } from "ink";
import type { ApiClient } from "@mnemic/shared";
import { ChatApp } from "./ChatApp.js";
import { ChatSession } from "./chat-session.js";

export async function startChat(api: ApiClient, projectId: string): Promise<number> {
  let code = 0;
  const instance = render(
    <ChatApp
      session={new ChatSession(api, projectId)}
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
