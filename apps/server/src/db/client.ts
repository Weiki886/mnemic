import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** 创建 DB 客户端；调用方（index.ts）保证仅在配置了 DATABASE_URL 时调用，未配置直接抛错 */
export function createDb(url: string = process.env.DATABASE_URL ?? "") {
  if (!url) {
    throw new Error("DATABASE_URL 未配置");
  }
  const client = postgres(url);
  return drizzle(client);
}
