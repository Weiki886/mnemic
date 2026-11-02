import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import {
  ChatConversationSchema,
  ChatCommitSchema,
  ConversationListSchema,
} from "@mnemic/shared/chat";
import {
  ConversationListQuerySchema,
  ConversationProjectParamsSchema,
  ConversationParamsSchema,
  ConversationIdParamsSchema,
  CreateConversationSchema,
  ResumeBodySchema,
  ConversationMessageViewSchema,
  ConversationDetailSchema,
  ResumeConversationResponseSchema,
} from "../src/contracts/conversation.js";

export function registerConversationPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const conversation = registry.register("Conversation", ChatConversationSchema);
  const list = registry.register("ConversationList", ConversationListSchema);
  const message = registry.register("ConversationMessage", ConversationMessageViewSchema);
  const detail = registry.register(
    "ConversationDetail",
    ConversationDetailSchema.extend({ messages: z.array(message) }),
  );
  const commit = registry.register("ConversationCommit", ChatCommitSchema);
  const resume = registry.register(
    "ConversationResume",
    ResumeConversationResponseSchema.extend({ messages: z.array(message) }),
  );
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error("Invalid UUID, query or request body; field errors when available."),
    401: error("Global operator Bearer required before body parsing or data access."),
    429: error("IP or authenticated-token request budget exhausted.", true),
    500: error("Server/database failure. Internal exception details are not returned."),
  };
  const bodyErrors = {
    413: error("Body exceeds the server limit."),
    415: error("Unsupported request content type."),
  };
  const scoped = {
    ...common,
    404: error("Conversation missing or outside the URL project; same response."),
  };
  const base = "/projects/{projectId}/conversations";
  registry.registerPath({
    method: "get",
    path: base,
    operationId: "listConversations",
    tags: ["Conversations"],
    summary: "List project conversations with message counts",
    description:
      "Global operator scope, not user-level ownership. Default limit 200 (max 1000), offset 0. Unknown query keys ignored. Missing project yields []. Stable order started_at then id, but offset pages are not a snapshot under concurrent writes. Counts include verified inherited messages. Broken/missing/foreign inherited references preserve the row with message_count=null and history_error=unavailable; otherwise count is an integer and history_error absent. This coupling is a runtime refinement. No model calls.",
    request: { params: ConversationProjectParamsSchema, query: ConversationListQuerySchema },
    responses: {
      ...common,
      200: {
        description: "One page, including empty/resumed and unavailable-history rows.",
        headers,
        content: { "application/json": { schema: list } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: base + "/{id}",
    operationId: "getConversation",
    tags: ["Conversations"],
    summary: "Read complete message timeline and resolved memory citations",
    description:
      "Includes inherited message references, without copying them. Full unpaginated history ordered by msg_time then id. Citations resolve against the same project, including historical/deleted beliefs; foreign or missing citation IDs are omitted. memories=null differs from a present empty array. Optional file metadata does not copy attachment content; raw_text is the stored message. Attachment parent/path constraints are validated at runtime; corrupt history or file parents return409. Query ignored. No model calls.",
    request: { params: ConversationParamsSchema },
    responses: {
      ...scoped,
      200: {
        description: "Conversation and messages, with optional tool/file/generation metadata.",
        headers,
        content: { "application/json": { schema: detail } },
      },
      409: error("Conversation history or file references unavailable."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/conversations",
    operationId: "createConversation",
    tags: ["Conversations"],
    summary: "Create an empty conversation in an existing project",
    description:
      "Returns200 (not201). Unknown body keys are stripped, query ignored. title is optional and not trimmed, but if present must be nonempty and at most200 characters. Exact reserved title manual-corrections is rejected by runtime refinement, not a generated schema enum. Same-title ordinary conversations are allowed. No model calls.",
    request: {
      body: {
        required: true,
        description:
          "Replace project_id with an existing project UUID. Example contains no deployment credential.",
        content: {
          "application/json": {
            schema: CreateConversationSchema,
            example: {
              project_id: "01900000-0000-7000-8000-000000000024",
              title: "API contract example",
            },
          },
        },
      },
    },
    responses: {
      ...common,
      ...bodyErrors,
      404: error("Project does not exist."),
      200: {
        description: "New empty conversation with ended_at=null.",
        headers,
        content: { "application/json": { schema: conversation } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/conversations/{id}/commit",
    operationId: "commitConversation",
    tags: ["Conversations"],
    summary: "Archive a conversation and register pending Evidence extraction",
    description:
      "Legacy global-ID route: project ownership is inferred from the conversation, no project parameter. Same global Bearer operator authorization applies. UUID is validated by the shared generation guard before database access. No required body; query ignored. Repeated commits, busy generation or invalid context return409. extraction_triggered means work registered, never extraction/indexing completed. With pending physical user/file Evidence, formal entry durably enqueues it in the archive transaction; library builds without a queue retain asynchronous in-process jobs. These jobs may invoke models and consume quota; this endpoint is not a paid probe.",
    request: { params: ConversationIdParamsSchema },
    responses: {
      ...common,
      ...bodyErrors,
      404: error("Conversation does not exist."),
      409: error("Already archived, generation busy/server closing, or context unavailable."),
      200: {
        description: "Archived conversation with extraction registration indicator.",
        headers,
        content: { "application/json": { schema: commit } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: base + "/{id}/resume",
    operationId: "resumeConversation",
    tags: ["Conversations"],
    summary: "Create a new conversation referencing verified source history",
    description:
      "Always creates a new fork, returns201, and archives open source/current conversations; never reopens or copies messages. Source and optional current_conversation_id must both belong to the URL project. An explicit JSON object (including {}) is required; unknown body keys rejected, query ignored. Reserved manual-corrections conversations and corrupt history return409. File paths/parents are validated at runtime. Any pending physical Evidence may be queued/extracted as for commit; inherited history is not extracted again. No automatic retry after an uncertain response.",
    request: {
      params: ConversationParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: ResumeBodySchema, example: {} } },
      },
    },
    responses: {
      ...scoped,
      ...bodyErrors,
      409: error("Reserved conversation, unavailable context, generation busy or service closing."),
      201: {
        description: "New fork with resumed_from and complete verified message views.",
        headers,
        content: { "application/json": { schema: resume } },
      },
    },
  });
}
