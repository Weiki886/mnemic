/** 启动配置解析（#62）：入口共用，禁止各入口各自 inline 解析。 */

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
 * HOST：默认 127.0.0.1——最小鉴权（#20）落地前，providers/chat 接口无保护，
 * 绑 0.0.0.0 等于向整个局域网开放；部署到容器/公网时须显式 HOST=0.0.0.0。
 */
export function resolveHost(raw: string | undefined): string {
  return raw ?? "127.0.0.1";
}
