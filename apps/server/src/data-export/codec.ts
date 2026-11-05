import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MEMORY_EXPORT_TABLES,
  MEMORY_EXPORT_LIMITS,
  MetadataSchema,
  ManifestSchema,
  ExportRecordSchema,
  RowEnvelopeSchema,
  EndSchema,
  type ExportRecord,
  type ExportTable,
  type MemoryExport,
} from "./format.js";
export { MEMORY_EXPORT_LIMITS } from "./format.js";

type ErrorCode = "EXPORT_INVALID" | "EXPORT_LIMIT_EXCEEDED" | "EXPORT_INTEGRITY_FAILED";
export class MemoryExportError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "MemoryExportError";
  }
}
const invalid = () => new MemoryExportError("EXPORT_INVALID");
const limit = () => new MemoryExportError("EXPORT_LIMIT_EXCEEDED");
const integrity = () => new MemoryExportError("EXPORT_INTEGRITY_FAILED");
const InputSchema = MetadataSchema.extend({ records: z.unknown() }).strict();
const id = z.string().uuid();
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const emptyCounts = () =>
  Object.fromEntries(MEMORY_EXPORT_TABLES.map((table) => [table, 0])) as Record<
    ExportTable,
    number
  >;
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid();
  }
}
function validateRow(row: ExportRecord, seen: Set<string>) {
  if (byteLength(row.row_json) > MEMORY_EXPORT_LIMITS.maxLineBytes) throw limit();
  if (/[\r\n]/.test(row.row_json)) throw invalid();
  // Avoid silently replacing caller-supplied unpaired surrogates with U+FFFD.
  if (Buffer.from(row.row_json, "utf8").toString("utf8") !== row.row_json) throw invalid();
  const parsed = parseJson(row.row_json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  if (!Object.hasOwn(parsed, "id")) throw invalid();
  const key = id.safeParse((parsed as Record<string, unknown>).id);
  if (!key.success) throw invalid();
  const identity = `${row.table}/${key.data.toLowerCase()}`;
  if (seen.has(identity)) throw invalid();
  seen.add(identity);
}

/** Pure, bounded archive preparation. No database reads, output files, audit writes or model calls. */
export function encodeMemoryExport(value: unknown): Buffer {
  const parsed = InputSchema.safeParse(value);
  if (!parsed.success || !Array.isArray(parsed.data.records)) throw invalid();
  const input = parsed.data;
  const records = input.records as unknown[];
  // Check before any per-element Zod traversal.
  if (records.length > MEMORY_EXPORT_LIMITS.maxRecords) throw limit();
  const counts = emptyCounts(),
    seen = new Set<string>(),
    hash = createHash("sha256"),
    parts: Buffer[] = [];
  let bytes = 0;
  const append = (line: string, hashed = true) => {
    if (byteLength(line) > MEMORY_EXPORT_LIMITS.maxLineBytes) throw limit();
    const part = Buffer.from(line + "\n", "utf8");
    bytes += part.length;
    if (bytes > MEMORY_EXPORT_LIMITS.maxBytes) throw limit();
    if (hashed) hash.update(part);
    parts.push(part);
  };
  append(
    JSON.stringify({
      kind: "manifest",
      format: "mnemic-memory-jsonl",
      schema_version: 1,
      export_id: input.export_id,
      created_at: input.created_at,
      tables: MEMORY_EXPORT_TABLES,
    }),
  );
  for (const value of records) {
    const parsed = ExportRecordSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const row = parsed.data;
    if (byteLength(row.row_json) > MEMORY_EXPORT_LIMITS.maxLineBytes) throw limit();
    const line = JSON.stringify({ kind: "row", table: row.table, row_json: row.row_json });
    // Escaping can expand a row; reject its wire size before parsing its inner JSON.
    if (byteLength(line) > MEMORY_EXPORT_LIMITS.maxLineBytes) throw limit();
    validateRow(row, seen);
    counts[row.table]++;
    append(line);
  }
  append(
    JSON.stringify({
      kind: "end",
      record_count: records.length,
      counts,
      sha256: hash.digest("hex"),
    }),
    false,
  );
  return Buffer.concat(parts, bytes);
}

/** Verify framing/integrity, preserving row_json text without JavaScript numeric conversion. */
export function decodeMemoryExport(value: Uint8Array): MemoryExport {
  if (!(value instanceof Uint8Array)) throw invalid();
  if (value.byteLength > MEMORY_EXPORT_LIMITS.maxBytes) throw limit();
  let text: string;
  try {
    text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw invalid();
  }
  if (!text.endsWith("\n") || text.includes("\r")) throw invalid();
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MEMORY_EXPORT_LIMITS.maxRecords + 2) throw limit();
  if (lines.length < 2 || lines.some((line) => !line)) throw invalid();
  if (lines.some((line) => byteLength(line) > MEMORY_EXPORT_LIMITS.maxLineBytes)) throw limit();
  const first = parseJson(lines[0]!);
  // A bounded manifest must be checked before Zod visits an arbitrary tables collection.
  if (
    !first ||
    typeof first !== "object" ||
    !Array.isArray((first as Record<string, unknown>).tables) ||
    ((first as Record<string, unknown>).tables as unknown[]).length !== MEMORY_EXPORT_TABLES.length
  )
    throw invalid();
  const header = ManifestSchema.safeParse(first),
    end = EndSchema.safeParse(parseJson(lines.at(-1)!));
  if (!header.success || !end.success) throw invalid();
  const counts = emptyCounts(),
    seen = new Set<string>(),
    records: ExportRecord[] = [],
    hash = createHash("sha256");
  hash.update(lines[0]! + "\n", "utf8");
  for (const line of lines.slice(1, -1)) {
    const parsed = RowEnvelopeSchema.safeParse(parseJson(line));
    if (!parsed.success) throw invalid();
    const { table, row_json } = parsed.data;
    validateRow(parsed.data, seen);
    counts[table]++;
    records.push(Object.freeze({ table, row_json }));
    hash.update(line + "\n", "utf8");
  }
  const sha256 = hash.digest("hex");
  if (
    records.length !== end.data.record_count ||
    Object.keys(end.data.counts).length !== MEMORY_EXPORT_TABLES.length ||
    MEMORY_EXPORT_TABLES.some((table) => counts[table] !== end.data.counts[table]) ||
    sha256 !== end.data.sha256
  )
    throw integrity();
  return Object.freeze({
    manifest: Object.freeze({ ...header.data, tables: Object.freeze([...header.data.tables]) }),
    records: Object.freeze(records),
    counts: Object.freeze(counts),
    sha256,
  });
}
