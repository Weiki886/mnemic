import { describe, expect, it } from "vitest";
import { decrypt, encrypt, maskApiKey, parseMasterKey } from "../src/providers/crypto.js";

const KEY_HEX = "a".repeat(64); // 32 字节测试主密钥

describe("Key 加密（AES-256-GCM）", () => {
  it("加密后可解密还原，密文不含明文", () => {
    const key = parseMasterKey(KEY_HEX);
    const secret = "sk-deepseek-abc123def456";
    const encrypted = encrypt(secret, key);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(decrypt(encrypted, key)).toBe(secret);
  });

  it("同一明文两次加密结果不同（随机 IV）", () => {
    const key = parseMasterKey(KEY_HEX);
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("错误密钥解密失败", () => {
    const key = parseMasterKey(KEY_HEX);
    const wrong = parseMasterKey("b".repeat(64));
    const encrypted = encrypt("secret", key);
    expect(() => decrypt(encrypted, wrong)).toThrow();
  });

  it("篡改密文解密失败（GCM 完整性）", () => {
    const key = parseMasterKey(KEY_HEX);
    const encrypted = encrypt("secret", key);
    const parts = encrypted.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from("tampered!!").toString("base64")}`;
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("主密钥解析：非法长度/非 hex 拒绝", () => {
    expect(() => parseMasterKey("tooshort")).toThrow();
    expect(() => parseMasterKey("z".repeat(64))).toThrow();
    expect(parseMasterKey(KEY_HEX)).toHaveLength(32);
  });
});

describe("Key 掩码", () => {
  it("sk- 前缀保留，尾部留 4 位", () => {
    expect(maskApiKey("sk-deepseek-abc123def456")).toBe("sk-••••f456");
  });
  it("非 sk- 前缀整体掩码", () => {
    expect(maskApiKey("dashscopekey9999")).toBe("••••9999");
  });
  it("过短 key 全掩码", () => {
    expect(maskApiKey("abc")).toBe("••••");
  });
});
