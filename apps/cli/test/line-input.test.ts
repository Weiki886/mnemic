import { describe, expect, it } from "vitest";
import { editLine } from "../src/line-input.js";

describe("synchronous line editing", () => {
  it("handles a large pasted log without a function-argument stack overflow", () => {
    const pasted = "x".repeat(200000);
    expect(editLine({ text: "ab", cursor: 1 }, pasted, {})).toEqual({
      text: `a${pasted}b`,
      cursor: 200001,
    });
  });
  it("inserts successive keys and pasted text at the current cursor", () => {
    let line = { text: "", cursor: 0 };
    for (const value of ["/", "memory", " ", "数据库 😀"]) line = editLine(line, value, {});
    expect(line).toEqual({ text: "/memory 数据库 😀", cursor: 13 });
    line = editLine(line, "", { leftArrow: true });
    line = editLine(line, "new ", {});
    expect(line.text).toBe("/memory 数据库 new 😀");
  });

  it("moves and backspaces by code point without splitting emoji", () => {
    let line = { text: "a😀b", cursor: 3 };
    line = editLine(line, "", { leftArrow: true });
    line = editLine(line, "", { backspace: true });
    expect(line).toEqual({ text: "ab", cursor: 1 });
    expect(editLine(line, "", { delete: true })).toEqual({ text: "b", cursor: 0 });
    expect(editLine({ text: "ab", cursor: 0 }, "", { leftArrow: true }).cursor).toBe(0);
    expect(editLine({ text: "ab", cursor: 2 }, "", { rightArrow: true }).cursor).toBe(2);
  });

  it("supports line boundaries and ignores command/control keys", () => {
    const line = { text: "abcd", cursor: 2 };
    expect(editLine(line, "", { home: true }).cursor).toBe(0);
    expect(editLine(line, "", { end: true }).cursor).toBe(4);
    for (const key of [
      { ctrl: true },
      { meta: true },
      { return: true },
      { tab: true },
      { upArrow: true },
      { escape: true },
    ])
      expect(editLine(line, "x", key)).toBe(line);
  });
});
