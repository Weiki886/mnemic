import { expect, it } from "vitest";
import { DebugEventSchema, ModelContentRecordSchema, parseDebugLine } from "./debug.js";
const project = "11111111-1111-4111-8111-111111111111",
  conversation = "22222222-2222-4222-8222-222222222222",
  target = "33333333-3333-4333-8333-333333333333";
const scope = {
  project_id: project,
  conversation_id: conversation,
  evidence_id: target,
  provider_name: "local",
  model_id: "chat",
  slot: "chat",
};
const prompt = {
  ts: "2026-10-26T09:00:00.000Z",
  event: "model.prompt",
  target_id: target,
  detail: {
    ...scope,
    complete: true,
    omitted_reason: null,
    content: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "memory/file" }] },
    ],
  },
};
it("accepts producer prompt and response variants with strict completeness invariants", () => {
  expect(ModelContentRecordSchema.parse(prompt)).toEqual(prompt);
  const response = {
    ...prompt,
    event: "model.response",
    detail: {
      ...scope,
      complete: false,
      omitted_reason: "incomplete",
      content: null,
      status: "aborted",
    },
  };
  expect(ModelContentRecordSchema.parse(response)).toEqual(response);
  expect(
    ModelContentRecordSchema.safeParse({
      ...response,
      detail: { ...response.detail, complete: true },
    }).success,
  ).toBe(false);
  expect(
    ModelContentRecordSchema.safeParse({ ...prompt, detail: { ...prompt.detail, complete: false } })
      .success,
  ).toBe(false);
});
it.each([
  { ...prompt, token: "secret" },
  { ...prompt, detail: { ...prompt.detail, providerMetadata: "secret" } },
  {
    ...prompt,
    detail: {
      ...prompt.detail,
      content: [{ role: "user", content: [{ type: "file", data: "secret" }] }],
    },
  },
  {
    ...prompt,
    detail: {
      ...prompt.detail,
      content: [{ role: "user", content: [{ type: "text", text: "x", extra: "secret" }] }],
    },
  },
])("rejects unknown fields and non-text parts: %j", (value) => {
  expect(ModelContentRecordSchema.safeParse(value).success).toBe(false);
});
it("extracts only known application records from a pino envelope, not arbitrary log content", () => {
  const line = {
    ...prompt,
    msg: "model debug content",
    level: 20,
    time: 0,
    pid: 1,
    hostname: "local",
    err: "NOT_PROJECTED",
  };
  expect(parseDebugLine(JSON.stringify(line))).toEqual(prompt);
  expect(parseDebugLine(JSON.stringify({ ...line, msg: "unhandled error" }))).toBeNull();
  expect(parseDebugLine("launcher garbage secret")).toBeNull();
  expect(parseDebugLine(JSON.stringify({ ...line, target_id: "secret" }))).toBeNull();
});
it("accepts mutation metadata with IDs and enums only, rejects body snapshots", () => {
  const row = {
    event: "memory.belief.corrected",
    target_id: target,
    detail: {
      project_id: project,
      observation_id: target,
      route: "conflict",
      relation: "supersede",
    },
  };
  expect(DebugEventSchema.parse(row)).toEqual(row);
  expect(
    DebugEventSchema.safeParse({ ...row, detail: { ...row.detail, value: "secret" } }).success,
  ).toBe(false);
  expect(
    DebugEventSchema.safeParse({
      event: "memory.pending.decided",
      target_id: target,
      detail: { project_id: project, evidence_id: target, status: "expired" },
    }).success,
  ).toBe(true);
});
