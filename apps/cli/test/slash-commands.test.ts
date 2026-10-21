import { describe, expect, it } from "vitest";
import { completeSlash, parseChatInput, slashHelp, SLASH_COMMANDS } from "../src/slash-commands.js";

const id = "a1920000-0000-7000-8000-000000000001";

describe("local slash command registry (#32, 1/3)", () => {
  it("uses the same implemented registry for help, parsing and completion", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help",
      "new",
      "resume",
      "exit",
    ]);
    for (const command of SLASH_COMMANDS) {
      expect(slashHelp()).toContain(command.usage);
      expect(slashHelp()).toContain(command.description);
      expect(completeSlash(`/${command.name}`).candidates).toEqual([`/${command.name}`]);
      expect(
        parseChatInput(`/${command.name}${command.name === "resume" ? ` ${id}` : ""}`),
      ).toMatchObject({ kind: "command", name: command.name });
    }
    expect(slashHelp()).not.toContain("/memory");
  });

  it.each(["", "   ", "\n\t"])("ignores empty input %j", (text) => {
    expect(parseChatInput(text)).toEqual({ kind: "empty" });
  });

  it.each(["  keep my spacing  ", "C:/project", "请解释 /new", "https://example.com"])(
    "preserves normal messages %j",
    (text) => {
      expect(parseChatInput(text)).toEqual({ kind: "message", text });
    },
  );

  it("accepts surrounding whitespace and normalizes resume UUID", () => {
    expect(parseChatInput(`  /resume  ${id.toUpperCase()}  `)).toEqual({
      kind: "command",
      name: "resume",
      argument: id,
    });
    expect(parseChatInput(" /help ")).toEqual({ kind: "command", name: "help" });
  });

  it.each([
    "/",
    "/Help",
    "/resuem",
    "/helpful",
    "/memory",
    "/new extra",
    "/exit now",
    "/help extra",
    "/resume",
    "/resume bad",
    `/resume ${id} extra`,
    "/tmp/file",
  ])("rejects unknown or malformed commands without chat fallback: %j", (text) => {
    expect(parseChatInput(text).kind).toBe("error");
  });

  it("completes only unambiguous command names, never arguments or normal text", () => {
    expect(completeSlash("/he")).toEqual({ value: "/help ", candidates: ["/help"] });
    expect(completeSlash("/re")).toEqual({ value: "/resume ", candidates: ["/resume"] });
    expect(completeSlash("/")).toEqual({
      value: "/",
      candidates: ["/help", "/new", "/resume", "/exit"],
    });
    for (const text of ["plain", "/unknown", "/resume ", `/resume ${id}`, "/he extra", "/he\n"]) {
      expect(completeSlash(text)).toEqual({ value: text, candidates: [] });
    }
  });

  it.each(["  ", "\u3000", "\t"])("preserves leading whitespace %j when completing", (prefix) => {
    expect(completeSlash(`${prefix}/he`)).toEqual({
      value: `${prefix}/help `,
      candidates: ["/help"],
    });
    expect(completeSlash(`${prefix}/`)).toEqual({
      value: `${prefix}/`,
      candidates: ["/help", "/new", "/resume", "/exit"],
    });
    for (const suffix of ["/unknown", "/resume ", "/he extra", "normal text"]) {
      const text = prefix + suffix;
      expect(completeSlash(text)).toEqual({ value: text, candidates: [] });
    }
  });
});
