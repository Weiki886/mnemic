import { expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { runCli } from "../src/cli.js";
import { parseChatInput, completeSlash } from "../src/slash-commands.js";
const project = "01920000-0000-7000-8000-000000000001";
it.each(["read-only", "confirm", "auto"])(
  "chat startup passes explicit %s mode and local root",
  async (mode) => {
    const startChat = vi.fn(async () => 0),
      fetch = vi.fn();
    expect(
      await runCli(["chat", "--project", project, "--approval-mode", mode, "--root", "./apps"], {
        startChat,
        fetch,
        isTTY: true,
        write: () => {},
        env: {},
      }),
    ).toBe(0);
    expect(startChat.mock.calls[0]?.slice(1)).toEqual([
      project,
      undefined,
      { mode, root: resolve("./apps") },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  ["chat", "--project", project, "--approval-mode", "unrestricted"],
  ["chat", "--project", project, "--root", "bad\nroot"],
  ["doctor", "--approval-mode", "auto"],
  ["sessions", "--project", project, "--root", "."],
])("rejects invalid or misplaced permission arguments before network: %j", async (...args) => {
  const fetch = vi.fn(),
    startChat = vi.fn(async () => 0);
  expect(await runCli(args, { fetch, startChat, isTTY: true, write: () => {}, env: {} })).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(startChat).not.toHaveBeenCalled();
});
it("local permissions command has strict parsing and participates in completion", () => {
  expect(parseChatInput("/permissions")).toEqual({
    kind: "command",
    name: "permissions",
    action: "show",
  });
  expect(parseChatInput("/permissions auto")).toEqual({
    kind: "command",
    name: "permissions",
    action: "mode",
    mode: "auto",
  });
  expect(parseChatInput("/permissions list")).toMatchObject({ action: "list" });
  expect(parseChatInput(`/permissions revoke ${project}`)).toMatchObject({
    action: "revoke",
    id: project,
  });
  for (const input of [
    "/permissions unrestricted",
    "/permissions confirm extra",
    "/permissions revoke ../file",
  ])
    expect(parseChatInput(input)).toMatchObject({ kind: "error" });
  expect(completeSlash("/perm").value).toBe("/permissions ");
});
