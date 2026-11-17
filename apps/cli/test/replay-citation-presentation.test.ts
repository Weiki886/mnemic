import { expect, it } from "vitest";
import { formatReply } from "../src/presentation.js";
import { ChatReplySchema } from "@mnemic/shared/chat";
it("labels the actual Observation/Evidence rather than printing a null version", () => {
  const id = "01920000-0000-7000-8000-000000000001";
  const reply = ChatReplySchema.parse({
    message_id: id,
    answer: "offline",
    abstained: false,
    memories: [
      {
        belief_id: id,
        belief_version_id: null,
        subject: "app",
        attribute: "database",
        value: "SQLite",
        provenance: {
          kind: "observation_replay",
          anchor_version_id: id,
          observation_id: id,
          evidence_id: id,
        },
      },
    ],
  });
  const text = formatReply(reply);
  expect(text).toContain(`Observation ${id}`);
  expect(text).toContain(`Evidence ${id}`);
  expect(text).not.toContain("版本 null");
});
