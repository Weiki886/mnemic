import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Provider API Key 加密（#14，ADR-005：Key 不回传前端、不入日志）。
 * 格式：v1:<iv_b64>:<tag_b64>:<ciphertext_b64>（AES-256-GCM，随机 12 字节 IV）。
 * 主密钥来自环境变量 MNEMIC_MASTER_KEY（64 位 hex = 32 字节），部署级配置。
 */

export function parseMasterKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("MNEMIC_MASTER_KEY 须为 64 位十六进制字符串（32 字节）");
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("密文格式非法（期望 v1:<iv>:<tag>:<ciphertext>）");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/** 掩码：sk- 前缀保留，尾部留 4 位；过短全掩码。任何对外的 Key 表示必须经此函数。 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length < 8) return "••••";
  const tail = apiKey.slice(-4);
  return apiKey.startsWith("sk-") ? `sk-••••${tail}` : `••••${tail}`;
}
