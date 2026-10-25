import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatSession } from "../src/chat-session.js";
import { encodeChatStreamEvent } from "../../../packages/shared/src/stream-protocol.js";
import { chatFailure } from "../src/presentation.js";
import { ApiError } from "@mnemic/shared";
const p = "01920000-0000-7000-8000-000000000001",
  c = "01920000-0000-7000-8000-000000000002";
const reply = { message_id: c, answer: "answer", abstained: true, memories: [] };
const row = {
  id: c,
  project_id: p,
  title: null,
  started_at: "2026-10-25T00:00:00Z",
  ended_at: null,
};
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mnemic35c-session-")));
  await writeFile(join(root, "README.md"), "captured snapshot");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function api() {
  return {
    createConversation: vi.fn(async () => row),
    sendMessage: vi.fn(async () => reply),
    commitConversation: vi.fn(async () => ({
      ...row,
      ended_at: "2026-10-25T01:00:00Z",
      extraction_triggered: false,
    })),
    resumeConversation: vi.fn(async () => ({ ...row, resumed_from: c, messages: [] })),
  };
}
it("loads once and notifies before any HTTP; JSON sends the captured snapshot with project scope", async () => {
  const client = api();
  client.createConversation.mockImplementationOnce(async () => {
    await writeFile(join(root, "README.md"), "changed later");
    return row;
  });
  const session = new ChatSession(client, p, root);
  const notices: string[] = [];
  await session.send("read @README.md", undefined, (notice) => {
    expect(client.createConversation).not.toHaveBeenCalled();
    notices.push(notice);
  });
  expect(notices[0]).toContain("README.md");
  expect(client.sendMessage).toHaveBeenCalledWith(p, c, "read @README.md", [
    { kind: "file", path: "README.md", content: "captured snapshot", truncated: false },
  ]);
});
it.each(['@"bad', "@missing", "@../escape", "@.env"])(
  "rejects %s before creating or sending a conversation",
  async (text) => {
    const client = api(),
      session = new ChatSession(client, p, root);
    const error = await session.send(text).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(chatFailure(error)).toContain("未发送");
    expect(client.createConversation).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    await expect(session.close()).resolves.toBeUndefined();
  },
);
it("synchronous cancellation from preparation notice prevents dispatch without uncertain state", async () => {
  const client = api(),
    session = new ChatSession(client, p, root);
  await expect(session.send("@README.md", undefined, () => session.interrupt())).rejects.toThrow(
    "cancelled",
  );
  expect(client.createConversation).not.toHaveBeenCalled();
  expect(client.sendMessage).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBeUndefined();
});
it("stream transport carries the same attachments in fifth position without JSON replay", async () => {
  const client = {
    ...api(),
    openMessageStream: vi.fn(
      async () =>
        new Response(
          encodeChatStreamEvent({
            type: "start",
            version: 1,
            conversation_id: c,
            generation_id: c,
            user_message_id: p,
          }) +
            encodeChatStreamEvent({
              type: "finish",
              generation_id: c,
              message_id: c,
              status: "complete",
              abstained: true,
              history_included: false,
              memories: [],
            }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
    cancelMessageStream: vi.fn(),
  };
  await new ChatSession(client, p, root).send("@README.md", () => {});
  expect(client.openMessageStream).toHaveBeenCalledWith(
    p,
    c,
    "@README.md",
    expect.any(AbortSignal),
    [expect.objectContaining({ path: "README.md", content: "captured snapshot" })],
  );
  expect(client.sendMessage).not.toHaveBeenCalled();
});
it("cancelling while conversation creation is pending is still a local unsent file cancellation", async () => {
  let finish!: (value: typeof row) => void;
  const client = { ...api(), openMessageStream: vi.fn(), cancelMessageStream: vi.fn() };
  client.createConversation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const session = new ChatSession(client, p, root);
  const sent = session.send("@README.md", () => {});
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  session.interrupt();
  finish(row);
  await expect(sent).rejects.toThrow("cancelled");
  expect(client.openMessageStream).not.toHaveBeenCalled();
  expect(client.sendMessage).not.toHaveBeenCalled();
});
it("JSON-only adapters also cancel a prepared file turn while conversation creation is pending", async () => {
  let finish!: (value: typeof row) => void;
  const client = api();
  client.createConversation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const session = new ChatSession(client, p, root);
  const sent = session.send("@README.md");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const wasPreparing = session.generating;
  session.interrupt();
  finish(row);
  await expect(sent).rejects.toThrow("cancelled");
  expect(wasPreparing).toBe(true);
  expect(client.sendMessage).not.toHaveBeenCalled();
});
it("a cancelled JSON file turn keeps local cancellation when conversation creation later rejects", async () => {
  let fail!: (error: Error) => void;
  const client = api();
  client.createConversation.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const session = new ChatSession(client, p, root);
  const sent = session.send("@README.md");
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  session.interrupt();
  fail(new ApiError(500, "INTERNAL_ERROR", "private startup failure"));
  await expect(sent).rejects.toThrow("cancelled");
  expect(client.sendMessage).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBeUndefined();
});
