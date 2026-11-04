import { expect, it } from "vitest";
import { ChatStreamCancelSchema } from "@mnemic/shared/chat-stream";
import {
  ChatStreamParamsSchema,
  CancelGenerationParamsSchema,
  CancelGenerationBodySchema,
  StreamEventContractSchema,
} from "../src/contracts/chat-stream.js";
const id = "019ABCDE-0000-7000-8000-000000000001";
const lower = id.toLowerCase();
const finish = {
  type: "finish",
  generation_id: lower,
  message_id: lower,
  status: "complete",
  abstained: false,
  history_included: false,
  memories: [
    { belief_id: lower, belief_version_id: lower, subject: "p", attribute: "a", value: null },
  ],
};
it("stream and cancel path rules retain lowercasing and strip unknown fields", () => {
  expect(ChatStreamParamsSchema.parse({ projectId: id, id, extra: true })).toEqual({
    projectId: lower,
    id: lower,
  });
  expect(CancelGenerationParamsSchema.parse({ projectId: id, id, generationId: id })).toEqual({
    projectId: lower,
    id: lower,
    generationId: lower,
  });
  expect(
    CancelGenerationParamsSchema.safeParse({ projectId: id, id, generationId: "bad" }).success,
  ).toBe(false);
});
it("cancel original strict empty body is retained; nullish acceptance stays at route normalization", () => {
  expect(CancelGenerationBodySchema.parse({})).toEqual({});
  for (const input of [null, undefined, [], false, { project_id: lower }])
    expect(CancelGenerationBodySchema.safeParse(input).success).toBe(false);
  for (const input of [null, undefined])
    expect(CancelGenerationBodySchema.parse(input ?? {})).toEqual({});
});
it("event contract reuses four strict protocol variants with required arbitrary JSON citation values", () => {
  for (const event of [
    {
      type: "start",
      version: 1,
      generation_id: lower,
      conversation_id: lower,
      user_message_id: lower,
    },
    { type: "delta", generation_id: lower, text: "x" },
    finish,
    { type: "error", generation_id: lower, code: "GENERATION_FAILED" },
  ]) {
    expect(StreamEventContractSchema.safeParse(event).success).toBe(true);
    expect(StreamEventContractSchema.safeParse({ ...event, secret: "no" }).success).toBe(false);
  }
  for (const value of [null, [null], { nested: null }, true, "x", 1])
    expect(
      StreamEventContractSchema.safeParse({
        ...finish,
        memories: [{ ...finish.memories[0], value }],
      }).success,
    ).toBe(true);
  const { value: _value, ...missing } = finish.memories[0]!;
  expect(StreamEventContractSchema.safeParse({ ...finish, memories: [missing] }).success).toBe(
    false,
  );
  expect(StreamEventContractSchema.safeParse({ ...finish, status: "failed" }).success).toBe(false);
  expect(
    StreamEventContractSchema.safeParse({ type: "delta", generation_id: lower, text: "" }).success,
  ).toBe(false);
  expect(
    StreamEventContractSchema.safeParse({
      type: "error",
      generation_id: lower,
      code: "raw-provider-error",
    }).success,
  ).toBe(false);
});
it("cancel output includes all three durable decisions, no answer or extra metadata", () => {
  for (const status of ["complete", "interrupted", "failed"])
    expect(
      ChatStreamCancelSchema.safeParse({ generation_id: lower, message_id: lower, status }).success,
    ).toBe(true);
  expect(
    ChatStreamCancelSchema.safeParse({ generation_id: lower, message_id: lower, status: "pending" })
      .success,
  ).toBe(false);
  expect(
    ChatStreamCancelSchema.safeParse({
      generation_id: lower,
      message_id: lower,
      status: "complete",
      answer: "x",
    }).success,
  ).toBe(false);
});
