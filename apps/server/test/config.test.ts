import { describe, expect, it } from "vitest";
import { resolveHost, resolvePort } from "../src/config.js";

describe("启动配置解析（#62）", () => {
  it("PORT：未配置默认 3000；合法整数字符串原样采用", () => {
    expect(resolvePort(undefined)).toBe(3000);
    expect(resolvePort("3999")).toBe(3999);
  });

  it("PORT：空字符串/非整数/越界一律拒绝启动（Number('') === 0 会变随机端口）", () => {
    expect(() => resolvePort("")).toThrow(/PORT/);
    expect(() => resolvePort("abc")).toThrow(/PORT/);
    expect(() => resolvePort("0")).toThrow(/PORT/);
    expect(() => resolvePort("65536")).toThrow(/PORT/);
    expect(() => resolvePort("3.5")).toThrow(/PORT/);
  });

  it("HOST：未配置默认 127.0.0.1（鉴权落地前不暴露局域网）；显式值原样采用", () => {
    expect(resolveHost(undefined)).toBe("127.0.0.1");
    expect(resolveHost("0.0.0.0")).toBe("0.0.0.0");
  });
});
