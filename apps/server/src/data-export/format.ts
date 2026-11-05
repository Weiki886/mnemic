import { z } from "zod";

/** #3 core tables only. This archive is not a whole-instance database backup. */
export const MEMORY_EXPORT_TABLES = Object.freeze([
  "projects",
  "conversations",
  "messages",
  "observations",
  "beliefs",
  "belief_versions",
  "memory_embeddings",
  "audit_log",
] as const);
export const MEMORY_EXPORT_LIMITS = Object.freeze({
  maxRecords: 10_000,
  maxLineBytes: 1024 * 1024,
  maxBytes: 16 * 1024 * 1024,
});
export const ExportTableSchema = z.enum(MEMORY_EXPORT_TABLES);
export type ExportTable = z.infer<typeof ExportTableSchema>;
export const MetadataSchema = z
  .object({ export_id: z.string().uuid(), created_at: z.string().datetime({ offset: true }) })
  .strict();
export const ManifestSchema = MetadataSchema.extend({
  kind: z.literal("manifest"),
  format: z.literal("mnemic-memory-jsonl"),
  schema_version: z.literal(1),
  tables: z
    .array(ExportTableSchema)
    .length(MEMORY_EXPORT_TABLES.length)
    .refine((tables) => tables.every((name, i) => name === MEMORY_EXPORT_TABLES[i])),
}).strict();
export const ExportRecordSchema = z
  .object({ table: ExportTableSchema, row_json: z.string() })
  .strict();
export const RowEnvelopeSchema = ExportRecordSchema.extend({ kind: z.literal("row") }).strict();
export const EndSchema = z
  .object({
    kind: z.literal("end"),
    record_count: z.number().int().min(0).max(MEMORY_EXPORT_LIMITS.maxRecords),
    counts: z.record(
      ExportTableSchema,
      z.number().int().min(0).max(MEMORY_EXPORT_LIMITS.maxRecords),
    ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ExportRecord = Readonly<z.infer<typeof ExportRecordSchema>>;
export interface MemoryExport {
  readonly manifest: Readonly<
    Omit<z.infer<typeof ManifestSchema>, "tables"> & { tables: readonly ExportTable[] }
  >;
  readonly records: readonly ExportRecord[];
  readonly counts: Readonly<Record<ExportTable, number>>;
  readonly sha256: string;
}
