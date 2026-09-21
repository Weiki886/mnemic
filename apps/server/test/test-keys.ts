import { parseMasterKey } from "../src/providers/crypto.js";

/**
 * 全部测试文件共用的测试主密钥：集成测试共享 mnemic_test 库，
 * 若各文件用不同密钥加密，跨文件读到他方行会解密失败（GCM 校验）。
 */
export const TEST_MASTER_KEY = parseMasterKey("e".repeat(64));
