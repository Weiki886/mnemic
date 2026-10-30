import { buildApp } from "./app.js";
import { listenWithGracefulShutdown } from "./server.js";
import { createDb } from "./db/client.js";
import { assertEmbeddingDimensions } from "./providers/dimension-guard.js";
import { parseMasterKey } from "./providers/crypto.js";
import {
  resolveAuthToken,
  resolveCorsOrigin,
  resolveHost,
  resolvePort,
  resolveDebugMode,
  resolveDebugContent,
  resolveModelDailyCallLimit,
} from "./config.js";
import { parseUsagePricing } from "./usage/pricing.js";

// 必须先校验鉴权配置再连接 DB/监听端口；不存在“空 Token 时放开接口”的启动模式。
const authToken = resolveAuthToken(process.env.MNEMIC_AUTH_TOKEN);
const debugMode = resolveDebugMode(process.env.MNEMIC_DEBUG);
const debugContent = resolveDebugContent(process.env.MNEMIC_DEBUG_CONTENT, debugMode);
const modelDailyCallLimit = resolveModelDailyCallLimit(process.env.MNEMIC_MODEL_DAILY_CALL_LIMIT);
const port = resolvePort(process.env.PORT);
const host = resolveHost(process.env.HOST);
const corsOrigin = resolveCorsOrigin(process.env.CORS_ORIGIN);
const usagePricing = parseUsagePricing(process.env.MNEMIC_USAGE_PRICES_JSON || undefined);

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

const app = buildApp({
  db,
  masterKey,
  corsOrigin,
  authToken,
  usagePricing,
  ...(db ? { modelDailyCallLimit } : {}),
  debugMode,
  debugContent,
  ...(db && masterKey ? { extractionQueue: {} } : {}),
});
if (db) {
  app.log.info("embedding 维度守卫通过");
}

await listenWithGracefulShutdown(app, { host, port });
