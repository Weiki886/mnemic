import { buildApp } from "./app.js";
import { listenWithGracefulShutdown } from "./server.js";
import { createDb } from "./db/client.js";
import { assertEmbeddingDimensions } from "./providers/dimension-guard.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

// embedding 维度守卫（#14）：配置了 DATABASE_URL 时启动即校验，
// 部署维度与库中向量列不一致则拒绝启动（提示 REEMBED）
if (process.env.DATABASE_URL) {
  await assertEmbeddingDimensions(createDb().$client);
  app.log.info("embedding 维度守卫通过");
}

await listenWithGracefulShutdown(app, { host, port });
