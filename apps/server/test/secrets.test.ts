import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/gate/secrets.js";

describe("Secret 检测与脱敏（#15，安全没有第二阶段）", () => {
  it("GitHub token（ghp_/github_pat_）命中并替换为 [REDACTED]", () => {
    const r = sanitizeText("我的 token 是 ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456 别外传");
    expect(r.text).toBe("我的 token 是 [REDACTED] 别外传");
    expect(r.hits.map((h) => h.pattern)).toContain("github_pat");
  });

  it("github_pat_ 细粒度 token", () => {
    const r = sanitizeText("github_pat_11ABCDEFG0ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn");
    expect(r.text).toBe("[REDACTED]");
    expect(r.hits[0]!.pattern).toBe("github_pat");
  });

  it("AWS Access Key（AKIA…）", () => {
    const r = sanitizeText("AKIAIOSFODNN7EXAMPLE 是我的 key");
    expect(r.text).toBe("[REDACTED] 是我的 key");
    expect(r.hits[0]!.pattern).toBe("aws_access_key");
  });

  it("sk- 风格 API Key", () => {
    const r = sanitizeText("key: sk-abcdefghijklmnop12345678");
    expect(r.text).toBe("key: [REDACTED]");
    expect(r.hits[0]!.pattern).toBe("openai_style_key");
  });

  it("密码赋值（password=…）", () => {
    const r = sanitizeText("数据库 password=Sup3rSecret! 记得改");
    expect(r.text).toBe("数据库 [REDACTED] 记得改");
    expect(r.hits[0]!.pattern).toBe("password_assignment");
  });

  it("私钥块", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const r = sanitizeText(`贴一下 ${pem} 完事`);
    expect(r.text).toBe("贴一下 [REDACTED] 完事");
    expect(r.hits[0]!.pattern).toBe("private_key_block");
  });

  it("干净文本原样通过，无命中", () => {
    const r = sanitizeText("数据库改用 SQLite，ORM 用 Drizzle");
    expect(r.text).toBe("数据库改用 SQLite，ORM 用 Drizzle");
    expect(r.hits).toHaveLength(0);
  });

  it("多处命中一次脱敏完毕", () => {
    const r = sanitizeText("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456 和 AKIAIOSFODNN7EXAMPLE");
    expect(r.text).toBe("[REDACTED] 和 [REDACTED]");
    expect(r.hits).toHaveLength(2);
  });

  it("命中记录只含模式名，绝不含密钥本体", () => {
    const secret = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456";
    const r = sanitizeText(`token=${secret}`);
    expect(JSON.stringify(r.hits)).not.toContain(secret);
  });
});
