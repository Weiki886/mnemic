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
      "memory",
      "forget",
    ]);
    for (const command of SLASH_COMMANDS) {
      expect(slashHelp()).toContain(command.usage);
      expect(slashHelp()).toContain(command.description);
      expect(completeSlash(`/${command.name}`).candidates).toEqual([`/${command.name}`]);
      expect(
        parseChatInput(
          `/${command.name}${["resume", "forget"].includes(command.name) ? ` ${id}` : ""}`,
        ),
      ).toMatchObject({ kind: "command", name: command.name });
    }
    expect(slashHelp()).not.toContain("/recall");
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
    "/recall",
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
      candidates: ["/help", "/new", "/resume", "/exit", "/memory", "/forget"],
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
      candidates: ["/help", "/new", "/resume", "/exit", "/memory", "/forget"],
    });
    for (const suffix of ["/unknown", "/resume ", "/he extra", "normal text"]) {
      const text = prefix + suffix;
      expect(completeSlash(text)).toEqual({ value: text, candidates: [] });
    }
  });

  it("parses memory filters, paging and plain search words", () => {
    expect(parseChatInput("/memory")).toEqual({
      kind: "command",
      name: "memory",
      query: { status: "active", limit: 20, offset: 0 },
    });
    expect(
      parseChatInput("/memory --type decision --status all --limit=5 --offset 10 db engine"),
    ).toEqual({
      kind: "command",
      name: "memory",
      query: { type: "decision", status: "all", limit: 5, offset: 10, q: "db engine" },
    });
    expect(parseChatInput(`/forget ${id.toUpperCase()}`)).toEqual({
      kind: "command",
      name: "forget",
      argument: id,
    });
    expect(completeSlash(" /m")).toEqual({ value: " /memory ", candidates: ["/memory"] });
    expect(completeSlash("/f")).toEqual({ value: "/forget ", candidates: ["/forget"] });
  });

  it.each([
    "/forget",
    "/forget bad",
    `/forget ${id} extra`,
    "/memory --type unknown",
    "/memory --status expired",
    "/memory --limit 0",
    "/memory --limit 1001",
    "/memory --limit 1e2",
    "/memory --limit -1",
    "/memory --offset 1.5",
    "/memory --offset 9007199254740992",
    "/memory --limit",
    "/memory --type fact --type fact",
    "/memory --limit 1 --limit 2",
    "/memory --json",
    `/memory ${"x".repeat(201)}`,
  ])("rejects invalid memory args locally: %s", (text) => {
    expect(parseChatInput(text).kind).toBe("error");
  });
});
