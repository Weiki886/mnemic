import { describe, expect, it } from "vitest";
import { normalizeTerm } from "../src/ingest/normalization.js";

describe("轻量规范化（#16，能力清单 1.5）", () => {
  it("大小写与首尾空白归一：MySQL / mysql / 'MYSQL ' 命中同一键", () => {
    expect(normalizeTerm("MySQL")).toBe("mysql");
    expect(normalizeTerm("mysql")).toBe("mysql");
    expect(normalizeTerm("MYSQL ")).toBe("mysql");
  });

  it("连续空白折叠", () => {
    expect(normalizeTerm("my   project")).toBe("my project");
  });

  it("别名映射：postgres/pgsql → postgresql", () => {
    expect(normalizeTerm("Postgres")).toBe("postgresql");
    expect(normalizeTerm("PGSQL")).toBe("postgresql");
  });

  it("未命中别名的词原样归一（小写）", () => {
    expect(normalizeTerm("Drizzle")).toBe("drizzle");
  });
});
