import { describe, expect, it } from "vitest";
import { classifyValues, normalizeValue } from "../src/resolver/value-compare.js";

describe("值比较（A0 启发式）", () => {
  it("字符串忽略大小写与首尾空白后相等 → equal", () => {
    expect(classifyValues("MySQL", "mysql ")).toBe("equal");
  });

  it("不同字符串 → conflict", () => {
    expect(classifyValues("MySQL", "PostgreSQL")).toBe("conflict");
  });

  it("新值字符串包含旧值 → extend", () => {
    expect(classifyValues("用 React", "用 React 和 TypeScript")).toBe("extend");
  });

  it("旧值包含新值（没带来新信息）→ equal", () => {
    expect(classifyValues("用 React 和 TypeScript", "用 react")).toBe("equal");
  });

  it("对象：新值是旧值超集 → extend", () => {
    expect(classifyValues({ orm: "drizzle" }, { orm: "drizzle", db: "sqlite" })).toBe("extend");
  });

  it("对象：同键不同值 → conflict", () => {
    expect(classifyValues({ db: "mysql" }, { db: "postgresql" })).toBe("conflict");
  });

  it("数组：新值是旧值超集 → extend，反之 equal", () => {
    expect(classifyValues(["a", "b"], ["a", "b", "c"])).toBe("extend");
    expect(classifyValues(["a", "b", "c"], ["B", "A"])).toBe("equal");
  });

  it("对象键序无关 → equal", () => {
    expect(classifyValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe("equal");
  });

  it("normalizeValue 递归规范化字符串与对象键序", () => {
    expect(normalizeValue({ B: " X ", a: [1, "Y"] })).toEqual({ a: [1, "y"], b: "x" });
  });
});
