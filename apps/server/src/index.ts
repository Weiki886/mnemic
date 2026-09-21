import { buildApp } from "./app.js";
import { listenWithGracefulShutdown } from "./server.js";
import { createDb } from "./db/client.js";
import { assertEmbeddingDimensions } from "./providers/dimension-guard.js";
import { parseMasterKey } from "./providers/crypto.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

// embedding 维度守卫（#14）：配置了 DATABASE_URL 时启动即校验，
// 部署维度与库中向量列不一致则拒绝启动（提示 REEMBED）
let db: ReturnType<typeof createDb> | undefined;
if (process.env.DATABASE_URL) {
  db = createDb();
  await assertEmbeddingDimensions(db.$client);
}
// 主密钥未配置时 Providers 配置 API 不注册（不泄露未加密链路）
const masterKey = process.env.MNEMIC_MASTER_KEY
  ? parseMasterKey(process.env.MNEMIC_MASTER_KEY)
  : undefined;

const app = buildApp({ db, masterKey });
if (db) {
  app.log.info("embedding 维度守卫通过");
}

await listenWithGracefulShutdown(app, { host, port });
