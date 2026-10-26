import { expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import {
  createModelDebug,
  MODEL_DEBUG_MAX_BYTES,
  type ModelContentRecord,
} from "../src/debug/model-content.js";
import { resolveDebugContent } from "../src/config.js";
import { buildApp } from "../src/app.js";

const ctx = {
  project_id: uuidv7(),
  conversation_id: uuidv7(),
  evidence_id: uuidv7(),
  provider_name: "local",
  model_id: "chat",
  slot: "chat" as const,
};
const key = "opaque-selected-provider-credential-012345";
const secret = "sk-debugsecret012345678901234567890";
const prompt = (text: string) => [
  { role: "system", content: "system" },
  { role: "user", content: [{ type: "text", text }] },
];
function fixture(credentials: string[] = []) {
  const rows: (ModelContentRecord & { msg?: string })[] = [];
  const debug = createModelDebug({ debug: (r, msg) => rows.push({ ...r, msg }) }, credentials);
  return { rows, begin: debug(ctx, key)! };
}
it("requires an independent explicit content switch and rejects inconsistent configuration safely", () => {
  expect(resolveDebugContent(undefined, true)).toBe(false);
  expect(resolveDebugContent("0", false)).toBe(false);
  expect(resolveDebugContent("1", true)).toBe(true);
  expect(() => resolveDebugContent("1", false)).toThrow(
    "MNEMIC_DEBUG_CONTENT requires MNEMIC_DEBUG=1",
  );
  expect(() => resolveDebugContent(secret, true)).toThrow("MNEMIC_DEBUG_CONTENT 必须为 0 或 1");
  expect(() => buildApp({ auth: false, debugContent: true })).toThrow(
    "MNEMIC_DEBUG_CONTENT requires MNEMIC_DEBUG=1",
  );
});
it("projects full ordered text and reasoning, pairs invocations, copies values and never reads envelopes", () => {
  const f = fixture();
  const input = prompt("history and memory 中文");
  const a = f.begin(input);
  const content = [
    { type: "reasoning", text: "think" },
    { type: "text", text: "answer" },
  ];
  Object.defineProperty(content[0], "providerMetadata", {
    get: () => {
      throw Error("must not inspect");
    },
  });
  a.output(content, "stop");
  a.finish("success");
  a.finish("error");
  expect(f.rows).toHaveLength(2);
  expect(f.rows[0]!).toMatchObject({
    event: "model.prompt",
    msg: "model debug content",
    detail: {
      ...ctx,
      complete: true,
      omitted_reason: null,
      content: input,
    },
  });
  expect(f.rows[1]!).toMatchObject({
    event: "model.response",
    target_id: f.rows[0]!.target_id,
    detail: { ...ctx, status: "success", complete: true, content },
  });
  input[0]!.content = "mutated";
  content[1]!.text = "mutated";
  expect(JSON.stringify(f.rows)).not.toContain("mutated");
  expect(f.begin(prompt("another"))).toBeDefined();
  expect(f.rows[2]!.target_id).not.toBe(f.rows[0]!.target_id);
});
it("redacts known credentials and Secret patterns in content and metadata without mutating business data", () => {
  const auth = "auth-token-opaque-012345678901234567890";
  const f = fixture([auth]);
  const input = `${auth} ${key} ${secret} password=verysecret -----BEGIN PRIVATE KEY-----\ntruncated`;
  const begin = createModelDebug({ debug: (r) => f.rows.push(r) }, [auth])(
    { ...ctx, model_id: key },
    key,
  )!;
  const a = begin(prompt(input));
  a.output([{ type: "text", text: input }], "stop");
  a.finish("success");
  const log = JSON.stringify(f.rows);
  for (const s of [auth, key, secret, "verysecret", "truncated"]) expect(log).not.toContain(s);
  expect(log).toContain("[REDACTED]");
  expect(input).toContain(key);
});
it("fails closed for secrets split across prompt fields or generated blocks", () => {
  const f = fixture();
  const a = f.begin([
    {
      role: "user",
      content: [
        { type: "text", text: key.slice(0, 10) },
        { type: "text", text: key.slice(10) },
      ],
    },
  ]);
  a.output(
    [
      { type: "text", text: secret.slice(0, 8) },
      { type: "reasoning", text: secret.slice(8) },
    ],
    "stop",
  );
  a.finish("success");
  expect(
    f.rows.every(
      (r) => r.detail.content === null && r.detail.omitted_reason === "cross_boundary_secret",
    ),
  ).toBe(true);
});
it("omits whole oversized or unsupported snapshots without touching binary payloads or truncating keys", () => {
  const f = fixture();
  const a = f.begin(prompt("a".repeat(MODEL_DEBUG_MAX_BYTES) + secret));
  const part = {
    type: "file",
    get data() {
      throw Error("binary must not be read");
    },
  };
  a.output([part], "stop");
  a.finish("success");
  expect(f.rows[0]!.detail).toMatchObject({
    complete: false,
    content: null,
    omitted_reason: "size_limit",
  });
  expect(f.rows[1]!.detail).toMatchObject({
    complete: false,
    content: null,
    omitted_reason: "unsupported",
  });
  expect(JSON.stringify(f.rows).length).toBeLessThan(2000);
});
it.each(["error", "aborted"] as const)(
  "never emits partial output on %s, even after a stop frame",
  (status) => {
    const f = fixture();
    const a = f.begin(prompt("x"));
    a.part({ type: "text-start", id: "t" });
    a.part({ type: "text-delta", id: "t", delta: key.slice(0, 8) });
    a.part({ type: "finish", finishReason: "stop" });
    a.finish(status);
    a.finish("success");
    expect(f.rows[1]!.detail).toMatchObject({
      status,
      content: null,
      complete: false,
      omitted_reason: "incomplete",
    });
    expect(JSON.stringify(f.rows)).not.toContain(key.slice(0, 8));
  },
);
it("stream deltas are accumulated before redaction and never logged individually", () => {
  const f = fixture();
  const a = f.begin(prompt("x"));
  a.part({ type: "text-start", id: "t" });
  for (const delta of ["answer ", key.slice(0, 10), key.slice(10)])
    a.part({ type: "text-delta", id: "t", delta });
  a.part({ type: "text-end", id: "t" });
  a.part({ type: "finish", finishReason: "stop" });
  expect(f.rows).toHaveLength(1);
  a.finish("success");
  expect(f.rows[1]!.detail.content).toEqual([{ type: "text", text: "answer [REDACTED]" }]);
});
it.each([undefined, "length", "tool-calls"])(
  "never claims incomplete finish %s is full",
  (finishReason) => {
    const f = fixture();
    const a = f.begin(prompt("x"));
    a.output([{ type: "text", text: "unsafe partial" }], finishReason);
    a.finish("success");
    expect(f.rows[1]!.detail).toMatchObject({
      content: null,
      complete: false,
      omitted_reason: "incomplete",
    });
  },
);
it("off does not inspect context or credentials; invalid scope and logger failure stay isolated", () => {
  const trap = new Proxy(ctx, {
    get() {
      throw Error("off");
    },
  });
  expect(createModelDebug()(trap, key)).toBeUndefined();
  const rows: unknown[] = [];
  const debug = createModelDebug({ debug: (r) => rows.push(r) });
  expect(debug({ ...ctx, evidence_id: secret }, key)).toBeUndefined();
  expect(rows).toEqual([]);
  const begin = createModelDebug({
    debug() {
      throw Error(secret);
    },
  })(ctx, key)!;
  expect(() => {
    const a = begin(prompt("x"));
    a.output([], "stop");
    a.finish("success");
  }).not.toThrow();
});
it("bounds message/part/chunk counts including zero-byte deltas and drops buffered content", () => {
  const f = fixture();
  const a = f.begin(Array.from({ length: 257 }, () => ({ role: "system", content: "x" })));
  a.part({ type: "text-start", id: "t" });
  for (let n = 0; n < 8193; n++) a.part({ type: "text-delta", id: "t", delta: "" });
  a.part({ type: "text-end", id: "t" });
  a.part({ type: "finish", finishReason: "stop" });
  a.finish("success");
  expect(
    f.rows.every((r) => r.detail.omitted_reason === "size_limit" && r.detail.content === null),
  ).toBe(true);
});

it("omits malformed streams and oversized block IDs without emitting provider metadata", () => {
  for (const id of ["x".repeat(129), ""]) {
    const f = fixture(),
      a = f.begin(prompt("x"));
    a.part({ type: "text-start", id });
    a.part({ type: "text-delta", id, delta: "answer" });
    a.part({ type: "text-end", id });
    a.part({ type: "finish", finishReason: "stop" });
    a.finish("success");
    expect(f.rows[1]!.detail).toMatchObject({
      complete: false,
      content: null,
      omitted_reason: "unsupported",
    });
  }
});
