import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  encodeMemoryExport,
  decodeMemoryExport,
  MemoryExportError,
  MEMORY_EXPORT_LIMITS,
} from "../src/data-export/codec.js";
const id = "019abcde-0000-7000-8000-000000000001";
const metadata = { export_id: id, created_at: "2026-11-05T00:00:00.123456Z" };
const tables = [
  "projects",
  "conversations",
  "messages",
  "observations",
  "beliefs",
  "belief_versions",
  "memory_embeddings",
  "audit_log",
] as const;
const input = (records: unknown[] = []) => ({ ...metadata, records });
const row = (table = "projects", row_json = `{"id":"${id}","name":"demo"}`) => ({
  table,
  row_json,
});
function error(fn: () => unknown, code = "EXPORT_INVALID") {
  try {
    fn();
    throw Error("expected rejection");
  } catch (e) {
    expect(e).toBeInstanceOf(MemoryExportError);
    expect((e as MemoryExportError).code).toBe(code);
    expect(String(e)).not.toContain("private-payload");
  }
}
function rewrite(raw: Uint8Array, change: (lines: Record<string, unknown>[]) => void) {
  const lines = Buffer.from(raw)
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((s) => JSON.parse(s));
  change(lines);
  return Buffer.from(lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
}
it("encodes an empty manifest/end archive with hand-computed line hash and all eight table counts", () => {
  const header = {
    kind: "manifest",
    format: "mnemic-memory-jsonl",
    schema_version: 1,
    ...metadata,
    tables,
  };
  const first = JSON.stringify(header) + "\n";
  const counts = Object.fromEntries(tables.map((t) => [t, 0]));
  const golden =
    first +
    JSON.stringify({
      kind: "end",
      record_count: 0,
      counts,
      sha256: createHash("sha256").update(first).digest("hex"),
    }) +
    "\n";
  const raw = encodeMemoryExport(input());
  expect(raw.toString("utf8")).toBe(golden);
  expect(decodeMemoryExport(Buffer.from(golden)).counts).toEqual(counts);
});
it("preserves exact inner PG JSON text including bigint/numeric lexemes, NULL, microseconds and escaped newline", () => {
  const raw = ` {"id":"${id}","n":9007199254740993,"price":0.12345678901234567890,"at":"2026-11-05T00:00:00.123456Z","v":[null,true],"text":"中文\\n\\"x\\""} `;
  const records = tables.map((table) => row(table, raw));
  const decoded = decodeMemoryExport(encodeMemoryExport(input(records)));
  expect(decoded.records).toEqual(records);
  expect(decoded.records[0]!.row_json).toBe(raw);
  expect(decoded.manifest.tables).toEqual(tables);
  expect(decoded.counts.belief_versions).toBe(1);
});
it("does not mutate caller objects and returns independently frozen metadata/record collections", () => {
  const original = input([row()]),
    before = structuredClone(original);
  const encoded = encodeMemoryExport(original);
  expect(original).toEqual(before);
  const decoded = decodeMemoryExport(encoded);
  original.records[0] = row("projects", `{"id":"${id}","name":"changed"}`);
  expect(decoded.records[0]!.row_json).not.toContain("changed");
  for (const value of [
    decoded,
    decoded.manifest,
    decoded.manifest.tables,
    decoded.records,
    decoded.records[0],
    decoded.counts,
  ])
    expect(Object.isFrozen(value)).toBe(true);
});
it.each([
  ["bad export ID", { export_id: "private-payload" }],
  ["bad time", { created_at: "private-payload" }],
  ["unknown metadata", { private_payload: "private-payload" }],
  ["non-array records", { records: {} }],
])("rejects %s with fixed non-content errors", (_name, extra) =>
  error(() => encodeMemoryExport({ ...input(), ...extra })),
);
it.each([
  { table: "provider_configs", row_json: `{"id":"${id}"}` },
  { table: "projects", row_json: "private-payload" },
  { table: "projects", row_json: "null" },
  { table: "projects", row_json: "[]" },
  { table: "projects", row_json: "{}" },
  { table: "projects", row_json: '{"id":"private-payload"}' },
  { table: "projects", row_json: `{"id":"${id}"}\n` },
  { table: "projects", row_json: `{"id":"${id}"}`, extra: true },
])("rejects invalid row envelope/object $table $row_json", (r) =>
  error(() => encodeMemoryExport(input([r]))),
);
it("duplicate row identities are rejected case-insensitively, but equal IDs in different tables are legal", () => {
  const a = row("projects", `{"id":"${id}"}`),
    b = row("projects", `{"id":"${id.toUpperCase()}"}`);
  error(() => encodeMemoryExport(input([a, b])));
  expect(decodeMemoryExport(encodeMemoryExport(input([a, row("messages")]))).records).toHaveLength(
    2,
  );
});
it.each([
  "version",
  "manifest extra",
  "table list",
  "end missing",
  "trailing row",
  "blank line",
  "CRLF",
  "BOM",
  "final LF missing",
])("rejects malformed archive: %s", (kind) => {
  const raw = encodeMemoryExport(input([row()]));
  let changed: Uint8Array;
  if (kind === "end missing")
    changed = Buffer.from(raw.toString().split("\n").slice(0, -2).join("\n") + "\n");
  else if (kind === "blank line") changed = Buffer.from(raw.toString().replace("\n", "\n\n"));
  else if (kind === "CRLF") changed = Buffer.from(raw.toString().replaceAll("\n", "\r\n"));
  else if (kind === "BOM") changed = Buffer.concat([Buffer.from([239, 187, 191]), raw]);
  else if (kind === "final LF missing") changed = raw.subarray(0, -1);
  else
    changed = rewrite(raw, (lines) => {
      if (kind === "version") lines[0]!.schema_version = 2;
      else if (kind === "manifest extra") lines[0]!.secret = "private-payload";
      else if (kind === "table list") lines[0]!.tables = ["projects"];
      else lines.push(lines[1]!);
    });
  error(() => decodeMemoryExport(changed));
});
it.each(["count", "table count", "checksum", "row tamper"])(
  "rejects integrity mismatch: %s",
  (kind) => {
    const changed = rewrite(encodeMemoryExport(input([row()])), (lines) => {
      const end = lines.at(-1)!;
      if (kind === "count") end.record_count = 2;
      else if (kind === "table count") (end.counts as Record<string, number>).projects = 2;
      else if (kind === "checksum") end.sha256 = "0".repeat(64);
      else lines[1]!.row_json = `{"id":"${id}","name":"tampered"}`;
    });
    error(() => decodeMemoryExport(changed), "EXPORT_INTEGRITY_FAILED");
  },
);
it("rejects invalid UTF8 instead of replacing bytes", () => {
  error(() => decodeMemoryExport(Buffer.from([255, 254, 10])));
});
it("checks array count before inspecting entries and line bytes before JSON.parse", () => {
  const entries = new Proxy(new Array(MEMORY_EXPORT_LIMITS.maxRecords + 1), {
    get(target, key, receiver) {
      if (key !== "length") throw Error("private-payload");
      return Reflect.get(target, key, receiver);
    },
  });
  error(() => encodeMemoryExport(input(entries)), "EXPORT_LIMIT_EXCEEDED");
  const parse = vi.spyOn(JSON, "parse");
  try {
    error(
      () =>
        encodeMemoryExport(
          input([row("projects", "x".repeat(MEMORY_EXPORT_LIMITS.maxLineBytes + 1))]),
        ),
      "EXPORT_LIMIT_EXCEEDED",
    );
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});
it("enforces wire UTF8 total/line budgets and decoder total bound before parsing", () => {
  error(
    () => decodeMemoryExport(new Uint8Array(MEMORY_EXPORT_LIMITS.maxBytes + 1)),
    "EXPORT_LIMIT_EXCEEDED",
  );
  const rows = Array.from({ length: 20 }, (_, i) =>
    row(
      "messages",
      `{"id":"01900000-0000-7000-8000-${String(i).padStart(12, "0")}","text":"${"中".repeat(300000)}"}`,
    ),
  );
  error(() => encodeMemoryExport(input(rows)), "EXPORT_LIMIT_EXCEEDED");
});

it("counts JSON escaping expansion and rejects an oversized wire line before parsing its row", () => {
  const raw = JSON.stringify({ id, text: "\\".repeat(300000) });
  expect(Buffer.byteLength(raw)).toBeLessThan(MEMORY_EXPORT_LIMITS.maxLineBytes);
  const parse = vi.spyOn(JSON, "parse");
  try {
    error(() => encodeMemoryExport(input([row("messages", raw)])), "EXPORT_LIMIT_EXCEEDED");
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});
it("decoder rejects an oversized individual line before JSON parsing", () => {
  const parse = vi.spyOn(JSON, "parse");
  try {
    error(
      () =>
        decodeMemoryExport(
          Buffer.from(" ".repeat(MEMORY_EXPORT_LIMITS.maxLineBytes + 1) + "\n{}\n"),
        ),
      "EXPORT_LIMIT_EXCEEDED",
    );
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});
it.each(["row extra", "end extra", "row table", "row JSON"])(
  "decoder enforces strict envelopes: %s",
  (kind) => {
    const raw = rewrite(encodeMemoryExport(input([row()])), (lines) => {
      if (kind === "row extra") lines[1]!.extra = "private-payload";
      else if (kind === "end extra") lines.at(-1)!.extra = "private-payload";
      else if (kind === "row table") lines[1]!.table = "provider_configs";
      else lines[1]!.row_json = "private-payload";
    });
    error(() => decodeMemoryExport(raw));
  },
);

it("accepts exactly the record limit without counting manifest/end as rows", () => {
  const records = Array.from({ length: MEMORY_EXPORT_LIMITS.maxRecords }, (_, i) =>
    row(
      "messages",
      JSON.stringify({ id: `019abcde-0000-7000-8000-${String(i).padStart(12, "0")}` }),
    ),
  );
  expect(decodeMemoryExport(encodeMemoryExport(input(records))).records).toHaveLength(
    MEMORY_EXPORT_LIMITS.maxRecords,
  );
});
it("the line limit is inclusive and counts wire escaping rather than raw character count", () => {
  const baseline = row("messages", JSON.stringify({ id, text: "" }));
  const fixed = Buffer.byteLength(JSON.stringify({ kind: "row", ...baseline }));
  const content = "x".repeat(MEMORY_EXPORT_LIMITS.maxLineBytes - fixed);
  const record = row("messages", JSON.stringify({ id, text: content }));
  const encoded = encodeMemoryExport(input([record]));
  expect(Buffer.byteLength(encoded.toString().split("\n")[1]!)).toBe(
    MEMORY_EXPORT_LIMITS.maxLineBytes,
  );
  expect(decodeMemoryExport(encoded).records).toEqual([record]);
  error(
    () => encodeMemoryExport(input([row("messages", JSON.stringify({ id, text: content + "x" }))])),
    "EXPORT_LIMIT_EXCEEDED",
  );
});
it("accepts the exact complete-file byte budget including framing and footer", () => {
  const records = Array.from({ length: 18 }, (_, i) =>
    row(
      "messages",
      JSON.stringify({ id: `019abcde-0000-7000-8000-${String(i).padStart(12, "0")}`, text: "" }),
    ),
  );
  let remaining = MEMORY_EXPORT_LIMITS.maxBytes - encodeMemoryExport(input(records)).length;
  for (const record of records) {
    const free =
      MEMORY_EXPORT_LIMITS.maxLineBytes -
      Buffer.byteLength(JSON.stringify({ kind: "row", ...record }));
    const add = Math.min(remaining, free);
    remaining -= add;
    record.row_json = JSON.stringify({ ...JSON.parse(record.row_json), text: "x".repeat(add) });
  }
  expect(remaining).toBe(0);
  const raw = encodeMemoryExport(input(records));
  expect(raw.length).toBe(MEMORY_EXPORT_LIMITS.maxBytes);
  expect(decodeMemoryExport(raw).records).toHaveLength(records.length);
});
