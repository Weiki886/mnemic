import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { consumeChatStream } from "../src/chat-stream.js";

const conversation = "01920000-0000-7000-8000-000000000001";
const generation = "01920000-0000-7000-8000-000000000002";
const user = "01920000-0000-7000-8000-000000000003";
const assistant = "01920000-0000-7000-8000-000000000004";
const start = `event: start\ndata: {"type":"start","version":1,"generation_id":"${generation}","conversation_id":"${conversation}","user_message_id":"${user}"}\n\n`;
const delta = `event: delta\ndata: {"type":"delta","generation_id":"${generation}","text":"真实分片😀"}\n\n`;
const finish = (status: string) =>
  `event: finish\ndata: {"type":"finish","generation_id":"${generation}","status":"${status}","message_id":"${assistant}","abstained":true,"history_included":false,"memories":[]}\n\n`;

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  task: (url: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing ephemeral port");
  try {
    await task(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}
function headers(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.flushHeaders();
}

describe("actual loopback HTTP collection (not a Mnemic route or real model)", () => {
  it.each(["complete", "interrupted"] as const)(
    "delivers deltas before the server sends the %s terminal acknowledgement",
    async (status) => {
      let response!: ServerResponse;
      let requests = 0,
        finished = false;
      await withServer(
        (req, res) => {
          requests++;
          req.resume();
          response = res;
          headers(res);
          res.write(start);
          res.write(delta);
        },
        async (url) => {
          const result = await consumeChatStream(
            await fetch(url, { method: "POST", body: "offline fixture" }),
            {
              conversationId: conversation,
              onEvent(event) {
                if (event.type !== "delta") return;
                expect(finished).toBe(false);
                expect(event.text).toBe("真实分片😀");
                finished = true;
                response.end(finish(status));
              },
            },
          );
          expect(result).toMatchObject({
            status,
            reply: { answer: "真实分片😀", message_id: assistant },
          });
          expect(requests).toBe(1);
        },
      );
    },
  );
  it("aborts the real response without replay, retaining only unconfirmed partial text", async () => {
    let requests = 0;
    let closed!: Promise<unknown>;
    await withServer(
      (_req, res) => {
        requests++;
        closed = once(res, "close");
        headers(res);
        res.write("retry: 1\n" + start + delta);
      },
      async (url) => {
        const controller = new AbortController();
        const error = await consumeChatStream(await fetch(url), {
          conversationId: conversation,
          signal: controller.signal,
          onEvent(event) {
            if (event.type === "delta") controller.abort("private-abort-reason");
          },
        }).catch((e) => e);
        expect(error).toMatchObject({ code: "ABORTED", progress: { answer: "真实分片😀" } });
        expect(error.progress.terminal).toBeUndefined();
        expect(error.message).not.toContain("private-abort-reason");
        await closed;
        expect(requests).toBe(1);
      },
    );
  });
  it("reports a real socket failure after a delta as unconfirmed, not interrupted or complete", async () => {
    let response!: ServerResponse;
    await withServer(
      (_req, res) => {
        response = res;
        headers(res);
        res.write(start + delta);
      },
      async (url) => {
        const error = await consumeChatStream(await fetch(url), {
          conversationId: conversation,
          onEvent(event) {
            if (event.type === "delta") response.destroy();
          },
        }).catch((e) => e);
        expect(error).toMatchObject({ code: "READ_FAILED", progress: { answer: "真实分片😀" } });
        expect(error.progress.terminal).toBeUndefined();
      },
    );
  });
  it("times out and closes a real stalled connection without retrying it", async () => {
    let requests = 0;
    let closed!: Promise<unknown>;
    await withServer(
      (_req, res) => {
        requests++;
        closed = once(res, "close");
        headers(res);
        res.write(": keepalive\n\n");
      },
      async (url) => {
        await expect(
          consumeChatStream(await fetch(url), { conversationId: conversation, timeoutMs: 20 }),
        ).rejects.toMatchObject({ code: "TIMEOUT" });
        await closed;
        expect(requests).toBe(1);
      },
    );
  });
});
