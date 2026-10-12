import { describe, expect, it } from "vitest";
import {
  formatConfidence,
  formatDateTime,
  formatValue,
  relationLabel,
  statusLabel,
} from "../src/lib/format.js";

describe("format helpers", () => {
  it("formats a timestamp in Beijing-facing local Chinese style", () => {
    expect(formatDateTime("2026-09-24T09:00:05Z")).toMatch(/2026/);
    expect(formatDateTime("2026-09-01")).toMatch(/2026/);
  });

  it("renders scalar and structured belief values without exposing undefined", () => {
    expect(formatValue("PostgreSQL")).toBe("PostgreSQL");
    expect(formatValue({ engine: "postgres" })).toBe('{"engine":"postgres"}');
    expect(formatValue(null)).toBe("—");
  });

  it("labels lifecycle status and resolver relations in interface language", () => {
    expect(statusLabel("active")).toBe("生效中");
    expect(statusLabel("deleted")).toBe("已删除");
    expect(statusLabel("retracted")).toBe("已撤回");
    expect(relationLabel("supersede")).toBe("取代");
    expect(relationLabel("late_evidence")).toBe("迟到证据");
  });

  it("formats confidence as a percentage with an absent state", () => {
    expect(formatConfidence(0.875)).toBe("88%");
    expect(formatConfidence(null)).toBe("—");
  });
});
