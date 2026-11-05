import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { setupTestDb } from "../db-helper.js";
import { MEMORY_EXPORT_TABLES } from "../../src/data-export/format.js";

/** Private core-table copies: global export tests never read or clear another test's data. */
export async function memoryExportDb() {
  const admin = await setupTestDb();
  const schema = `export_${uuidv7().replaceAll("-", "")}`;
  await admin.sql`create schema ${admin.sql(schema)}`;
  for (const table of MEMORY_EXPORT_TABLES)
    await admin.sql`create table ${admin.sql(schema)}.${admin.sql(table)} (like public.${admin.sql(table)} including all)`;
  const sql = postgres(admin.url, { max: 4, connection: { search_path: `${schema},public` } });
  return {
    sql,
    db: drizzle(sql),
    async close() {
      await sql.end();
      await admin.sql`drop schema ${admin.sql(schema)} cascade`;
      await admin.close();
    },
  };
}
