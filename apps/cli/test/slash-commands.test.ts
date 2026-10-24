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
      "recall",
      "status",
      "config",
      "permissions",
    ]);
    for (const command of SLASH_COMMANDS) {
      expect(slashHelp()).toContain(command.usage);
      expect(slashHelp()).toContain(command.description);
      expect(completeSlash(`/${command.name}`).candidates).toEqual([`/${command.name}`]);
      expect(
        parseChatInput(
          `/${command.name}${["resume", "forget"].includes(command.name) ? ` ${id}` : command.name === "recall" ? " db" : ""}`,
        ),
      ).toMatchObject({ kind: "command", name: command.name });
    }
    expect(slashHelp()).toContain("embedding");
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
    expect(completeSlash("/re")).toEqual({ value: "/re", candidates: ["/resume", "/recall"] });
    expect(completeSlash("/")).toEqual({
      value: "/",
      candidates: [
        "/help",
        "/new",
        "/resume",
        "/exit",
        "/memory",
        "/forget",
        "/recall",
        "/status",
        "/config",
        "/permissions",
      ],
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
      candidates: [
        "/help",
        "/new",
        "/resume",
        "/exit",
        "/memory",
        "/forget",
        "/recall",
        "/status",
        "/config",
        "/permissions",
      ],
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

  it("explains how to search for words starting with a dash", () => {
    expect(parseChatInput("/memory -db")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("/memory -- -db"),
    });
    expect(parseChatInput("/memory -- -db")).toMatchObject({
      kind: "command",
      name: "memory",
      query: { q: "-db" },
    });
  });

  it("parses recall query without shell parsing, with a bounded explicit billing action", () => {
    expect(parseChatInput(" /recall  PostgreSQL   storage ")).toEqual({
      kind: "command",
      name: "recall",
      query: "PostgreSQL   storage",
    });
    expect(parseChatInput("/recall --help")).toMatchObject({
      kind: "command",
      name: "recall",
      query: "--help",
    });
    for (const text of ["/recall", "/recall   ", `/recall ${"x".repeat(1001)}`])
      expect(parseChatInput(text).kind).toBe("error");
    expect(completeSlash("/rec")).toEqual({ value: "/recall ", candidates: ["/recall"] });
  });

  it("parses management commands without accepting credentials or deployment embedding changes", () => {
    expect(parseChatInput("/status")).toMatchObject({ name: "status", kind: "command" });
    expect(parseChatInput("/config")).toMatchObject({ name: "config", action: "show" });
    expect(parseChatInput(`/config set ${id} chat next-model`)).toMatchObject({
      name: "config",
      action: "set",
      id,
      patch: { models: { chat: "next-model" } },
    });
    expect(parseChatInput(`/config set ${id} name My Provider`)).toMatchObject({
      patch: { name: "My Provider" },
    });
    for (const command of [
      "/status extra",
      "/config extra",
      `/config set ${id} api_key secret`,
      `/config set ${id} embedding new`,
      `/config set bad chat model`,
      `/config set ${id} base_url https://user:secret@host`,
    ])
      expect(parseChatInput(command).kind).toBe("error");
    expect(completeSlash("/s")).toEqual({ value: "/status ", candidates: ["/status"] });
    expect(completeSlash("/c")).toEqual({ value: "/config ", candidates: ["/config"] });
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
