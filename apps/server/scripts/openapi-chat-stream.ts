import { z } from "zod";
import { normalizeNullability } from "./openapi-nullability.js";
import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import { ChatMessageInputSchema } from "@mnemic/shared/file-context";
import { ChatStreamCancelSchema } from "@mnemic/shared/chat-stream";
import {
  ChatStreamParamsSchema,
  CancelGenerationParamsSchema,
  CancelGenerationBodySchema,
  StreamEventContractSchema,
} from "../src/contracts/chat-stream.js";

export function registerChatStreamPaths(registry: OpenAPIRegistry) {
  const input = registry.register("ChatMessageInput", ChatMessageInputSchema);
  // OAS3 has no standard per-frame SSE schema location. Generate inline extension data
  // from Zod; an extension-only component reference is invisible to unused-component lint.
  const events = new OpenAPIRegistry();
  events.register("ChatStreamEvent", StreamEventContractSchema);
  const eventSchema = new OpenApiGeneratorV3(events.definitions).generateComponents().components!
    .schemas!.ChatStreamEvent!;
  normalizeNullability(eventSchema);
  const cancelled = registry.register("ChatStreamCancel", ChatStreamCancelSchema);
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry
      ? headers.extend({
          "Retry-After": z
            .string()
            .regex(/^[1-9]\d*$/)
            .optional(),
        })
      : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error("Invalid UUID/body or malformed JSON; field errors when available."),
    401: error("Global Bearer rejected before JSON parsing or database access."),
    404: error(
      "Unknown/foreign scope, missing generation, or route unregistered without DB/master key.",
    ),
    413: error("Request body exceeds server limit."),
    415: error("Unsupported media type; text/plain parses but fails object validation with400."),
    429: error(
      "IP/token request budget rejected before body/data/model work. Cancellation is also subject to these buckets; rejection is not a cancellation acknowledgement.",
      true,
    ),
    500: error(
      "Fixed server/database failure; no exception payloads. Do not automatically replay.",
    ),
    default: error(
      "Other errors handled by the existing application boundary use problem+json. Once the SSE response has started, failures use an error event instead of a new HTTP status.",
    ),
  };
  const base = "/projects/{projectId}/conversations/{id}";
  const id = "01900000-0000-7000-8000-000000000001";
  const conversation = "01900000-0000-7000-8000-000000000002";
  const user = "01900000-0000-7000-8000-000000000003";
  const example = [
    {
      type: "start",
      version: 1,
      generation_id: id,
      conversation_id: conversation,
      user_message_id: user,
    },
    { type: "delta", generation_id: id, text: "Offline answer." },
    {
      type: "finish",
      generation_id: id,
      message_id: id,
      status: "complete",
      abstained: true,
      history_included: false,
      memories: [],
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  registry.registerPath({
    method: "post",
    path: base + "/messages/stream",
    operationId: "streamChatMessage",
    tags: ["Conversations"],
    summary: "Admit user/file Evidence and stream a persisted answer decision",
    description:
      "Same strict message/attachment rules, sanitization limits and global operator scope as JSON send. Both URL UUIDs normalized to lowercase and conversation project checked before revealing busy state; query ignored, ordinary CORS. Requires DB/master key. Before admission, invalid/foreign/archived/broken-history requests use problem+json. Single-instance coordinator permits one active SSE per conversation, excludes competing mutations and caps active SSE generations at32; not a distributed lock. After atomic Evidence/outbox admission, success200 is a text/event-stream byte stream, never a JSON array; a start event is emitted before model preparation. HTTP200/start do not prove generation success. Each frame is event:<type> plus one JSON data line, separated by an empty line; event name must equal data.type. x-sse-event-schema is this contract's extension describing each parsed data object, not an OpenAPI-standard SSE sequencing guarantee. Exactly one start, zero or more nonempty delta frames, then finish or error if transport remains writable. IDs remain constant: start.conversation_id matches URL, generation_id equals persisted assistant message ID, finish.message_id equals generation_id. Delta concatenation is the visible answer; no reasoning or provider-error payload is emitted. finish complete/interrupted is emitted only after assistant persistence; complete reflects accepted SDK termination, not a guarantee finishReason was stop (length/tool-calls can terminate normally). An error GENERATION_FAILED can accompany a saved failed prefix; PERSISTENCE_FAILED means no successful save acknowledgement. EOF/disconnect without a terminal event is unconfirmed, not successful cancellation. No SSE id/retry or Last-Event-ID replay, no automatic retry/resume. Query embedding and chat may bill; chat stream maxRetries=0, other SDK calls/background extraction have their own retry policies. Retrieval errors may degrade to no-memory. Once started, model/config/quota failures become200+error events, not JSON401/429/503. Evidence/queued work can remain after failure. Prefix is saved as interrupted for explicit cancel, disconnect, deadline or shutdown when persistence succeeds; this does not prove provider billing stopped. Default generation deadline300s starts after admission and covers preparation/streaming, not admission DB waits; 30s backpressure abort and deadline+30s transport guard apply, no all-SQL hard timeout. Bounds: delta<=16384 UTF16 units, each encoded event<=128KiB, visible and text+reasoning budgets2MiB, wire8MiB with terminal headroom. Successful SSE headers no-store and X-Accel-Buffering:no. A saved terminal may still be lost in transport; use scoped cancel/status receipt or read history before deciding a new send. Durable work registration does not mean extraction/indexing completed.",
    request: {
      params: ChatStreamParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: input,
            example: {
              text: "Summarize the attached note.",
              attachments: [
                {
                  kind: "file",
                  path: "README.md",
                  content: "Offline project note.",
                  truncated: false,
                },
              ],
            },
          },
        },
      },
    },
    responses: {
      ...common,
      409: error(
        "Archived/unavailable history, conversation busy/closing or32 active streams; no new Evidence admitted by these route checks.",
      ),
      200: {
        description:
          "SSE wire text. Parse each JSON data object using the inline event schema, then enforce sequence/ID/persistence rules above.",
        headers: headers.extend({
          "Cache-Control": z.literal("no-store"),
          "X-Accel-Buffering": z.literal("no"),
        }),
        content: {
          "text/event-stream": {
            schema: z.string().openapi({
              description:
                "SSE frames; x-sse-event-schema describes data JSON, not the whole wire string.",
              ...{ "x-sse-event-schema": eventSchema },
            }),
            example,
          },
        },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: base + "/generations/{generationId}/cancel",
    operationId: "cancelChatGeneration",
    tags: ["Conversations"],
    summary: "Request interruption and read the durable generation decision",
    description:
      "All three UUID paths normalized to lowercase. Same global Bearer and request rate budgets; project+conversation+assistant message must match. Query ignored. Body may be absent or JSON null (both normalized to{}); a provided object must be strictly empty. text/plain is parsed but rejected400; unsupported media415. If matching generation is active in this process, signal abort and wait for its persistence decision, not downstream frame draining. Then query saved assistant state. Response200 may be complete/interrupted/failed; it reports the existing durable decision, not a promise the call changed it to interrupted or stopped provider billing. generation_id=message_id; no answer body or citations. Repeating after completion returns same saved decision without model calls or new rows. Unknown/foreign/non-assistant/legacy assistant with null generation_status gives404; active generation with failed save gives500, subsequent request after release may instead return404. Multi-instance routing may miss another process's active registry; no distributed cancellation or crash-recovery promise. No guaranteed no-store or end-to-end SQL deadline for this legacy cancellation response. Failure/timeout/429 is not a save receipt; do not resend the original chat request automatically.",
    request: {
      params: CancelGenerationParamsSchema,
      body: {
        required: false,
        content: {
          "application/json": { schema: CancelGenerationBodySchema.nullable(), example: {} },
        },
      },
    },
    responses: {
      ...common,
      200: {
        description:
          "Persisted assistant decision, not a new execution or billing-stop acknowledgement.",
        headers,
        content: { "application/json": { schema: cancelled } },
      },
      500: error(
        "Active generation finished without a saved assistant decision, or database failure. No successful cancellation acknowledgement.",
      ),
    },
  });
}
