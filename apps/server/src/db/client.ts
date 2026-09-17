import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** 延迟创建：未配置 DATABASE_URL 时不阻塞 server 启动（本期 DB 非必需） */
export function createDb(url: string = process.env.DATABASE_URL ?? "") {
  if (!url) {
    throw new Error("DATABASE_URL 未配置");
  }
  const client = postgres(url);
  return drizzle(client);
}
