import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { RecallResultSchema } from "@mnemic/shared/memory";
const doc = JSON.parse(
  readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, formats: { uuid: /^[0-9a-f-]{36}$/i } });
ajv.addSchema({ components: doc.components }, "recall-replay");
const validate = ajv.compile({ $ref: "recall-replay#/components/schemas/RecallResult" });
const id = "01920000-0000-7000-8000-000000000001";
const flags = {
  retrieval_vector: false,
  retrieval_keyword: true,
  retrieval_entity: false,
  retrieval_time: false,
  memory_gate: true,
  decay: false,
  reranker: false,
  authority_resolution: true,
  read_time_resolution: true,
  read_time_reinforcement: false,
};
const score = {
  beliefVersionId: id,
  vectorScore: null,
  keywordScore: 1,
  fusedScore: 1,
  selected: true,
  reason: "top_k",
};
const memory = {
  belief_id: id,
  belief_version_id: null,
  subject: "app",
  attribute: "db",
  value: null,
  provenance: {
    kind: "observation_replay",
    anchor_version_id: id,
    observation_id: id,
    evidence_id: id,
  },
};
const body = {
  project_id: id,
  query: "db",
  abstained: false,
  candidates: [{ ...score, beliefId: id, subject: "app", attribute: "db", value: "old" }],
  trace: {
    id,
    reinforce_enabled: false,
    flags_snapshot: { schema_version: 1, revision: 0, flags },
    candidate_count: 1,
    truncated: false,
    candidates: [score],
  },
  read_time_context: { abstained: false, memories: [memory] },
};
it("committed recall contract accepts distinct replay sources including JSON null", () => {
  expect(RecallResultSchema.parse(body)).toEqual(body);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
});
it.each([123, {}, [], true, "old-version"])(
  "null-only replay version cannot be widened in OpenAPI %j",
  (belief_version_id) => {
    const invalid = {
      ...body,
      read_time_context: {
        ...body.read_time_context,
        memories: [{ ...memory, belief_version_id }],
      },
    };
    expect(RecallResultSchema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);
  },
);
