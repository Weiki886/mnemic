import { expect, it } from "vitest";
import { ChatMessageInputSchema } from "@mnemic/shared/file-context";
import { ChatMessageParamsSchema, JsonChatReplySchema } from "../src/contracts/chat-message.js";
const id = "019ABCDE-0000-7000-8000-000000000001";
const file = (content = "hello", path = "README.md") => ({
  kind: "file",
  path,
  content,
  truncated: false,
});
it("message path rules preserve UUID lowercasing and original stripping", () => {
  expect(ChatMessageParamsSchema.parse({ projectId: id, id, ignored: true })).toEqual({
    projectId: id.toLowerCase(),
    id: id.toLowerCase(),
  });
  expect(ChatMessageParamsSchema.safeParse({ projectId: "bad", id }).success).toBe(false);
});
it("strict message and attachment inputs retain text and reject unknown properties", () => {
  expect(ChatMessageInputSchema.parse({ text: "  " })).toEqual({ text: "  " });
  expect(ChatMessageInputSchema.safeParse({ text: "x", flags: {} }).success).toBe(false);
  expect(
    ChatMessageInputSchema.safeParse({
      text: "x",
      attachments: [{ ...file(), source_type: "USER_CORRECTION" }],
    }).success,
  ).toBe(false);
  for (const text of ["", "x".repeat(8001)])
    expect(ChatMessageInputSchema.safeParse({ text }).success).toBe(false);
});
it("file refinements reject secret paths, duplicate paths, control bytes and UTF8 byte overflow", () => {
  for (const attachment of [
    file("x", "../outside"),
    file("x", ".env"),
    file("\u0000"),
    file("中".repeat(5500)),
  ])
    expect(ChatMessageInputSchema.safeParse({ text: "x", attachments: [attachment] }).success).toBe(
      false,
    );
  expect(
    ChatMessageInputSchema.safeParse({ text: "x", attachments: [file(), file()] }).success,
  ).toBe(false);
  expect(
    ChatMessageInputSchema.safeParse({
      text: "x",
      attachments: Array.from({ length: 9 }, (_, i) => file("x", `f${i}`)),
    }).success,
  ).toBe(false);
  expect(
    ChatMessageInputSchema.safeParse({
      text: "x",
      attachments: Array.from({ length: 5 }, (_, i) => file("x".repeat(16384), `f${i}`)),
    }).success,
  ).toBe(false);
  expect(
    ChatMessageInputSchema.safeParse({ text: "x", attachments: [file("x", ".")] }).success,
  ).toBe(false);
});
it("JSON success requires explicit history and arbitrary citation value, including null", () => {
  const row = {
    message_id: id.toLowerCase(),
    answer: "",
    abstained: true,
    history_included: false,
    memories: [
      {
        belief_id: id.toLowerCase(),
        belief_version_id: id.toLowerCase(),
        subject: "p",
        attribute: "x",
        value: null,
      },
    ],
  };
  for (const value of [null, true, 3, "x", [null], { nested: null }])
    expect(
      JsonChatReplySchema.safeParse({ ...row, memories: [{ ...row.memories[0], value }] }).success,
    ).toBe(true);
  const { history_included: _history, ...missing } = row;
  expect(JsonChatReplySchema.safeParse(missing).success).toBe(false);
  const { value: _value, ...citation } = row.memories[0]!;
  expect(JsonChatReplySchema.safeParse({ ...row, memories: [citation] }).success).toBe(false);
});
