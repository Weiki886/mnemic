import { expect, it } from "vitest";
import { ChatStreamEventSchema } from "../src/stream-protocol.js";
import * as chat from "../src/chat.js";

const id = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const provenance = {
  kind: "observation_replay",
  anchor_version_id: id(2),
  observation_id: id(3),
  evidence_id: id(4),
};
const citation = {
  belief_id: id(1),
  belief_version_id: null,
  subject: "app",
  attribute: "database",
  value: "SQLite",
  provenance,
};
const reply = (memories: unknown[]) => ({
  message_id: id(5),
  answer: "offline",
  abstained: false,
  memories,
});
it("accepts replay citations without inventing a version for their values", () => {
  expect(chat.ChatReplySchema.parse(reply([citation])).memories).toEqual([citation]);
});
it("preserves legacy version citations in mixed response order", () => {
  const legacy = {
    belief_id: id(1),
    belief_version_id: id(2),
    subject: "app",
    attribute: "database",
    value: "PostgreSQL",
  };
  expect(chat.ChatReplySchema.parse(reply([citation, legacy])).memories).toEqual([
    citation,
    legacy,
  ]);
});
it.each([
  { ...citation, provenance: undefined },
  { ...citation, provenance: { ...provenance, observation_id: "bad" } },
  { ...citation, provenance: { ...provenance, kind: "version" } },
  { ...citation, provenance: { ...provenance, value: "forged" } },
])("rejects invalid replay provenance %#", (input) => {
  expect(chat.ChatReplySchema.safeParse(reply([input])).success).toBe(false);
});
it("strict stored reference contract allows only IDs and normalizes UUIDs", () => {
  const ref = {
    kind: "observation_replay",
    belief_id: id(1),
    anchor_version_id: id(2),
    observation_id: id(3),
    evidence_id: id(4),
  };
  expect(chat.ReplayMemoryReferenceSchema.parse(ref)).toEqual(ref);
  expect(
    chat.ReplayMemoryReferenceSchema.safeParse({ ...ref, value: "copied content" }).success,
  ).toBe(false);
  expect(
    chat.ReplayMemoryReferenceSchema.safeParse({ ...ref, belief_version_id: id(2) }).success,
  ).toBe(false);
});

it("SSE finish accepts replay sources but keeps strict citation fields", () => {
  const finish = {
    type: "finish",
    generation_id: id(5),
    status: "complete",
    message_id: id(5),
    abstained: false,
    history_included: false,
    memories: [citation],
  };
  expect(ChatStreamEventSchema.parse(finish)).toEqual(finish);
  expect(
    ChatStreamEventSchema.safeParse({ ...finish, memories: [{ ...citation, extra: "unexpected" }] })
      .success,
  ).toBe(false);
});
