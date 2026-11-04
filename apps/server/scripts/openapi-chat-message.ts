import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import { ChatMessageInputSchema } from "@mnemic/shared/file-context";
import { ChatMessageParamsSchema, JsonChatReplySchema } from "../src/contracts/chat-message.js";

export function registerJsonMessagePath(registry: OpenAPIRegistry) {
  const input = registry.register("ChatMessageInput", ChatMessageInputSchema);
  const output = registry.register("JsonChatReply", JsonChatReplySchema);
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  registry.registerPath({
    method: "post",
    path: "/projects/{projectId}/conversations/{id}/messages",
    operationId: "sendJsonChatMessage",
    tags: ["Conversations"],
    summary: "Admit user/file Evidence and save a complete JSON answer",
    description:
      "Requires database, master key and global operator Bearer; absent dependencies mean route404. UUID paths normalized to lowercase, both project and conversation must match before busy state or admission. Query ignored, strict body. text is 1–8000 characters, not trimmed. Attachments are client-declared relative paths and UTF8 text, never server file reads. Runtime refinements reject sensitive/escaping paths, duplicate paths, invalid Unicode/control bytes, more than8 files or8 directories, more than16 total entries, single content above16KiB or total above64KiB. Generated structure does not fully encode these refinements. User text is stored as supplied; only file path/content is sanitized before storage/prompt. Never submit credentials in user text. File Evidence is separately anchored to the physical user message and assigned PROJECT_FILE authority by trusted writeback, not by model/client labels. Sanitization is not complete secret detection or prompt-injection prevention. Evidence admission plus durable outbox is atomic; inherited history is validated before admission. Formal entry uses queued extraction; library builds without a queue retain in-process writeback. A successful answer does not prove extraction/indexing finished. Retrieval may call paid embedding, then chat may call a paid model; SDK retries and later extraction can add invocations. Retrieval errors, including embedding quota denial, degrade to an ungrounded answer; abstained refers to memory retrieval, not a promise the generated answer is empty or unknown. Response contains complete answer and selected citations, no token stream; history_included describes model history. message_id identifies the persisted assistant message, whose stored references contain only version IDs; citation value is required arbitrary JSON including null. Unlike SSE, this legacy JSON route has no generation ID, cancellation receipt, explicit deadline, no-store guarantee or distributed serialization. Concurrent JSON sends may overlap. HTTP disconnect does not establish upstream cancellation. After Evidence admission, chat/config/quota/database/save failures can leave user/file Evidence and queued work without an assistant reply; some409 responses can occur after paid work. Repeating the same request creates new Evidence; no idempotency key or automatic retry. Ordinary CORS applies, Origin is not universally rejected.",
    request: {
      params: ChatMessageParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: input,
            example: {
              text: "Summarize the attached project note.",
              attachments: [
                {
                  kind: "file",
                  path: "README.md",
                  content: "The offline example uses PostgreSQL.",
                  truncated: false,
                },
              ],
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: "Complete saved assistant answer; does not acknowledge extraction completion.",
        headers,
        content: { "application/json": { schema: output } },
      },
      400: error("Invalid path/body or malformed JSON; structured field errors when available."),
      401: error("Bearer required before parsing JSON, data access or model calls."),
      404: error("Missing/foreign conversation, or route unavailable without DB/master key."),
      409: error(
        "Archived/busy/closing conversation or corrupt inherited/file history; a concurrent archive can also prevent saving an already generated answer.",
      ),
      413: error("Request body exceeds server limit."),
      415: error("Unsupported media type. text/plain parses but fails object validation with400."),
      429: error(
        "HTTP request budget before admission (RATE_LIMITED), or chat daily model quota after Evidence admission (MODEL_QUOTA_EXCEEDED). Embedding quota errors may instead degrade retrieval. No automatic resend.",
        true,
      ),
      500: error(
        "Fixed server/config/model/storage failure; admitted Evidence or paid work may already exist. Internal exception payloads not returned.",
      ),
      503: error(
        "Chat model quota admission unavailable (MODEL_QUOTA_UNAVAILABLE), possibly after Evidence admission. Retry-After is a wait suggestion, not permission to replay this non-idempotent request.",
        true,
      ),
    },
  });
}
