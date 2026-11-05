import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { writePlatformAudit } from "../audit/events.js";
import { encodeMemoryExport, MemoryExportError } from "./codec.js";
import {
  MEMORY_EXPORT_TABLES,
  MEMORY_EXPORT_LIMITS,
  type ExportRecord,
  EndSchema,
} from "./format.js";

/** Whole-instance core rows. No filters, arbitrary identifiers or Provider/model access. */
export async function prepareMemoryExport(db: PostgresJsDatabase) {
  return db.transaction(
    async (tx) => {
      // Each query/lock wait is bounded. No write locks are taken on source rows.
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(sql`set local lock_timeout = '1s'`);
      const [clock] = await tx.execute<{ created_at: string }>(
        sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`,
      );
      const export_id = uuidv7(),
        records: ExportRecord[] = [];
      let bytes = 0;
      const overflow = () => new MemoryExportError("EXPORT_LIMIT_EXCEEDED");
      for (const table of MEMORY_EXPORT_TABLES) {
        let after: string | null = null;
        for (;;) {
          // Fixed allowlist identifiers, keyset pagination, <=8 raw rows per roundtrip.
          // Oversized raw values are measured by PostgreSQL, never transferred to JS.
          const page: { id: string; row_json: string | null }[] = await tx.execute(sql`
          select id,case when octet_length(raw)<=${MEMORY_EXPORT_LIMITS.maxLineBytes} then raw else null end as row_json
          from (select r.id,to_jsonb(r)::text as raw from ${sql.identifier(table)} r
            ${after ? sql`where r.id > ${after}::uuid` : sql``}
            order by r.id limit 8) bounded order by id`);
          for (const row of page) {
            if (records.length >= MEMORY_EXPORT_LIMITS.maxRecords || row.row_json === null)
              throw overflow();
            const record = { table, row_json: row.row_json };
            const lineBytes = Buffer.byteLength(JSON.stringify({ kind: "row", ...record }), "utf8");
            bytes += lineBytes + 1;
            if (
              lineBytes > MEMORY_EXPORT_LIMITS.maxLineBytes ||
              bytes > MEMORY_EXPORT_LIMITS.maxBytes
            )
              throw overflow();
            records.push(record);
          }
          if (page.length < 8) break;
          after = page.at(-1)!.id;
        }
      }
      // The codec includes manifest/footer in final bounds and validates every raw row.
      const payload = encodeMemoryExport({ export_id, created_at: clock!.created_at, records });
      const end = EndSchema.parse(
        JSON.parse(
          payload.subarray(payload.lastIndexOf(10, payload.length - 2) + 1, -1).toString("utf8"),
        ),
      );
      await writePlatformAudit(tx, {
        actor: "server",
        action: "memory.export",
        target: export_id,
        decision: "prepared",
        meta: {
          version: 1,
          scope: "instance",
          format: "mnemic-memory-jsonl",
          schema_version: 1,
          export_id,
          rows: records.length,
          bytes: payload.length,
          sha256: end.sha256,
        },
      });
      return { payload, export_id };
    },
    { isolationLevel: "repeatable read", accessMode: "read write" },
  );
}
