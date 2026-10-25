import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

async function api() {
  const url = new URL("../src/file-references.ts", import.meta.url);
  expect(existsSync(url), "explicit @ file reference parser must exist").toBe(true);
  return import(url.href) as Promise<typeof import("../src/file-references.js")>;
}

describe("explicit file reference syntax", () => {
  it.each(["@bad\ud800.txt", "@bad\udc00.txt"])(
    "rejects an isolated Unicode surrogate before local IO",
    async (text) => {
      const { parseFileReferences } = await api();
      expect(() => parseFileReferences(text)).toThrow("invalid_path");
    },
  );
  it("recognizes bare and quoted references with original UTF-16 offsets", async () => {
    const { parseFileReferences } = await api();
    const text = '🙂 看 @README.md 和 @"src/a b.ts"，然后继续';
    const refs = parseFileReferences(text);
    expect(refs.map((ref) => ref.path)).toEqual(["README.md", "src/a b.ts"]);
    expect(refs.map((ref) => text.slice(ref.start, ref.end))).toEqual([
      "@README.md",
      '@"src/a b.ts"',
    ]);
  });
  it("ignores emails, embedded at signs, lone @ and escaped @@ tokens", async () => {
    const { parseFileReferences } = await api();
    expect(parseFileReferences("a@example.com name@file (@file) @ @@file")).toEqual([]);
    expect(parseFileReferences("普通聊天没有引用")).toEqual([]);
  });
  it("preserves quoted literal path characters instead of shell expansion", async () => {
    const { parseFileReferences } = await api();
    expect(parseFileReferences('@"$(touch marker).ts" @*.ts').map((ref) => ref.path)).toEqual([
      "$(touch marker).ts",
      "*.ts",
    ]);
  });
  it.each(['@"unterminated', '@""', '@"file"suffix'])(
    "rejects malformed quoted reference %s",
    async (text) => {
      const { parseFileReferences } = await api();
      expect(() => parseFileReferences(text)).toThrowError("invalid_reference");
    },
  );
  it.each(["@/etc/passwd", "@../secret", "@src/../../secret", "@C:/private", "@~/secret"])(
    "rejects non-project-relative path %s before filesystem access",
    async (text) => {
      const { parseFileReferences } = await api();
      expect(() => parseFileReferences(text)).toThrowError("invalid_path");
    },
  );
  it.each(['@"bad\npath"', "@bad\u202epath", "@bad\0path", "@src\\file.ts"])(
    "rejects control/bidi and ambiguous separator paths",
    async (text) => {
      const { parseFileReferences } = await api();
      expect(() => parseFileReferences(text)).toThrowError("invalid_path");
    },
  );
  it("accepts normalized in-root paths and a directory root reference", async () => {
    const { parseFileReferences } = await api();
    expect(parseFileReferences("@./src/../README.md @.").map((ref) => ref.path)).toEqual([
      "README.md",
      ".",
    ]);
  });
  it("bounds input and number of explicit references", async () => {
    const { parseFileReferences } = await api();
    expect(() => parseFileReferences("a".repeat(8001))).toThrowError("input_too_large");
    expect(() => parseFileReferences(Array(9).fill("@README.md").join(" "))).toThrowError(
      "too_many_references",
    );
    expect(parseFileReferences(Array(8).fill("@README.md").join(" "))).toHaveLength(8);
  });
});
