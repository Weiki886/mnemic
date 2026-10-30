/** 启动配置解析（#62）：入口共用，禁止各入口各自 inline 解析。 */

/** Debug is an operator-only startup choice, never inferred from a request or LOG_LEVEL. */
export function resolveDebugMode(raw: string | undefined): boolean {
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error("MNEMIC_DEBUG 必须为 0 或 1");
}

/** 单用户 Bearer Token：32–256 个协议允许的 ASCII 字符，禁止默认口令/空白配置。 */
export function resolveAuthToken(raw: string | undefined): string {
  if (!raw || !/^[A-Za-z0-9._~+/-]{32,256}=*$/.test(raw) || raw.length > 256) {
    throw new Error(
      "MNEMIC_AUTH_TOKEN 必须为 32–256 位 Bearer Token；可用 openssl rand -hex 32 生成",
    );
  }
  return raw;
}

/**
 * PORT：合法整数 1–65535 才接受；空字符串（Number('') === 0 → 随机端口）、
 * 非数字、越界一律拒绝启动，避免"以为起了 3000 实际随机"的静默偏差。
 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined) return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`PORT 非法：${JSON.stringify(raw)}（须为 1–65535 的整数）`);
  }
  return n;
}

/**
 * HOST：默认仍为 127.0.0.1；鉴权不替代传输加密，部署时须显式 HOST=0.0.0.0 并配置 HTTPS。
 */
export function resolveHost(raw: string | undefined): string {
  return raw ?? "127.0.0.1";
}

/**
 * CORS_ORIGIN（#8）：Web 记忆中心（vite dev :5173）跨源调 API 所需。
 * 默认 http://localhost:5173；生产部署显式设为前端源。单源放开即可，
 * 单源允许 Bearer 请求头；预检仅协商跨源协议，不放行业务请求。
 */
export function resolveCorsOrigin(raw: string | undefined): string {
  return raw ?? "http://localhost:5173";
}

/** Content capture requires a second operator opt-in; old debug mode stays metadata-only. */
export function resolveDebugContent(raw: string | undefined, debugMode: boolean): boolean {
  if (raw !== undefined && raw !== "0" && raw !== "1")
    throw new Error("MNEMIC_DEBUG_CONTENT 必须为 0 或 1");
  if (raw === "1" && !debugMode) throw new Error("MNEMIC_DEBUG_CONTENT requires MNEMIC_DEBUG=1");
  return raw === "1";
}

/** Startup-only cap; never echo a possibly secret invalid value. No zero/unlimited mode. */
export function resolveModelDailyCallLimit(raw: string | undefined): number {
  if (raw === undefined) return 1000;
  if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > 1_000_000)
    throw new Error("MNEMIC_MODEL_DAILY_CALL_LIMIT must be an integer from 1 to 1000000");
  return Number(raw);
}
