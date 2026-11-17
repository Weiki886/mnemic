import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { ConversationMessageViewSchema } from "../src/contracts/conversation.js";
import { StreamEventContractSchema } from "../src/contracts/chat-stream.js";
import { JsonChatReplySchema } from "../src/contracts/chat-message.js";
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({
  strict: false,
  formats: { uuid: /^[0-9a-f-]{36}$/i, "date-time": /^\d{4}-\d\d-\d\dT/ },
});
ajv.addSchema({ components: doc.components }, "replay-contract");
const id = "01920000-0000-7000-8000-000000000001";
const citation = {
  belief_id: id,
  belief_version_id: null,
  subject: "app",
  attribute: "database",
  value: null,
  provenance: {
    kind: "observation_replay",
    anchor_version_id: id,
    observation_id: id,
    evidence_id: id,
  },
};
const cases = [
  {
    schema: ConversationMessageViewSchema,
    name: "ConversationMessage",
    wrap: (memories: unknown[]) => ({
      id,
      speaker: "assistant",
      raw_text: "offline",
      msg_time: "2026-09-24T09:00:00Z",
      memories,
    }),
  },
  {
    schema: JsonChatReplySchema,
    name: "JsonChatReply",
    wrap: (memories: unknown[]) => ({
      message_id: id,
      answer: "offline",
      abstained: false,
      history_included: false,
      memories,
    }),
  },
  {
    schema: StreamEventContractSchema,
    name: "ChatStreamEvent",
    wrap: (memories: unknown[]) => ({
      type: "finish",
      generation_id: id,
      status: "complete",
      message_id: id,
      abstained: false,
      history_included: false,
      memories,
    }),
  },
];
it.each(cases)(
  "$name preserves null-only replay versions in committed OpenAPI",
  ({ name, schema, wrap }) => {
    const validate = ajv.compile(
      name === "ChatStreamEvent"
        ? doc.paths["/projects/{projectId}/conversations/{id}/messages/stream"].post.responses[
            "200"
          ].content["text/event-stream"].schema["x-sse-event-schema"]
        : { $ref: `replay-contract#/components/schemas/${name}` },
    );
    expect(schema.safeParse(wrap([citation])).success).toBe(true);
    expect(validate(wrap([citation])), JSON.stringify(validate.errors)).toBe(true);
    for (const value of [123, {}, [], true, "not-a-version"]) {
      const forged = wrap([{ ...citation, belief_version_id: value }]);
      expect(schema.safeParse(forged).success).toBe(false);
      expect(validate(forged), `${name} wrongly accepted ${JSON.stringify(value)}`).toBe(false);
    }
    // The citation's value is still arbitrary JSON, including null and arrays.
    for (const value of [null, 123, {}, ["fact"]])
      expect(validate(wrap([{ ...citation, value }]))).toBe(true);
  },
);
