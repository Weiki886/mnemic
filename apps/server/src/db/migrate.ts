import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** 与服务复用同一生产包和迁移文件；无 drizzle-kit/开发依赖，执行完释放连接。 */
export async function migrateDatabase(url: string = process.env.DATABASE_URL ?? ""): Promise<void> {
  if (!url) throw new Error("DATABASE_URL is required for migrations");
  const client = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await migrateDatabase();
    console.info("Database migrations applied");
  } catch {
    // 连接错误可能含数据库 URL/密码，不将原始异常打印到容器日志。
    console.error("Database migrations failed; check connection and schema");
    process.exitCode = 1;
  }
}
