import { expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import {
  ConversationListQuerySchema,
  ConversationParamsSchema,
  ConversationIdParamsSchema,
  CreateConversationSchema,
  ResumeBodySchema,
  ConversationDetailSchema,
} from "../src/contracts/conversation.js";
it("list defaults and coercion preserve 200/0 with unknown keys stripped", () => {
  expect(ConversationListQuerySchema.parse({ extra: true })).toEqual({ limit: 200, offset: 0 });
  expect(ConversationListQuerySchema.parse({ limit: "1", offset: "2" })).toEqual({
    limit: 1,
    offset: 2,
  });
  expect(ConversationListQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
  expect(ConversationListQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
});
it("create strips extras but still forbids reserved or empty titles", () => {
  const project_id = uuidv7();
  expect(CreateConversationSchema.parse({ project_id, title: "discussion", extra: true })).toEqual({
    project_id,
    title: "discussion",
  });
  for (const title of ["", "manual-corrections", "x".repeat(201)])
    expect(CreateConversationSchema.safeParse({ project_id, title }).success).toBe(false);
});
it("resume accepts explicit empty JSON object and rejects unknown keys", () => {
  expect(ResumeBodySchema.parse({})).toEqual({});
  expect(ResumeBodySchema.safeParse(undefined).success).toBe(false);
  expect(ResumeBodySchema.safeParse({ extra: true }).success).toBe(false);
  expect(ResumeBodySchema.safeParse({ current_conversation_id: "bad" }).success).toBe(false);
});
it("existing guard UUID normalization and project validation stay intact", () => {
  const id = "01900000-ABCD-7000-8000-000000000001";
  expect(ConversationIdParamsSchema.parse({ id })).toEqual({ id: id.toLowerCase() });
  expect(ConversationIdParamsSchema.safeParse({ id: "bad" }).success).toBe(false);
  expect(ConversationParamsSchema.safeParse({ projectId: "bad", id }).success).toBe(false);
});
it("message output accepts tool/file/interrupted metadata and requires citation values even when null", () => {
  const id = uuidv7(),
    at = "2026-11-01T00:00:00Z";
  const cited = {
    belief_id: uuidv7(),
    belief_version_id: uuidv7(),
    subject: "p",
    attribute: "data",
    value: null,
  };
  const message = {
    id: uuidv7(),
    speaker: "tool",
    raw_text: "output",
    msg_time: at,
    memories: [cited],
    generation_status: "interrupted",
  };
  const body = {
    id,
    project_id: uuidv7(),
    title: null,
    started_at: at,
    ended_at: null,
    messages: [message],
  };
  expect(ConversationDetailSchema.safeParse(body).success).toBe(true);
  const { value: _value, ...missing } = cited;
  expect(
    ConversationDetailSchema.safeParse({ ...body, messages: [{ ...message, memories: [missing] }] })
      .success,
  ).toBe(false);
  expect(
    ConversationDetailSchema.safeParse({ ...body, messages: [{ ...message, memories: null }] })
      .success,
  ).toBe(true);
});
