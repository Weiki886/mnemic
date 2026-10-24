import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalEvaluationSchema } from "../../../packages/shared/src/approval.js";

async function load() {
  const url = new URL("../src/approval-policy.ts", import.meta.url);
  expect(existsSync(url), "approval policy evaluator must exist").toBe(true);
  return import(url.href) as Promise<typeof import("../src/approval-policy.js")>;
}
const project = "01920000-0000-7000-8000-000000000001",
  session = "01920000-0000-7000-8000-000000000002",
  other = "01920000-0000-7000-8000-000000000003";
let base: string, root: string, sibling: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mnemic34-")));
  root = join(base, "project");
  sibling = join(base, "project-sibling");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(sibling);
  await writeFile(join(root, "existing.ts"), "unchanged");
  await writeFile(join(sibling, "private.ts"), "outside-secret");
  await symlink(join(root, "sub"), join(root, "alias"));
  await symlink(sibling, join(root, "escape"));
  await symlink(join(root, "existing.ts"), join(root, "file-link.ts"));
  await symlink(join(sibling, "missing"), join(root, "broken"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});
const context = (mode?: string, grants: unknown[] = []) => ({
  project_id: project,
  session_id: session,
  root,
  ...(mode === undefined ? {} : { mode }),
  grants,
});
const grant = (scope: "session" | "permanent" = "session") => ({
  project_id: project,
  root,
  target: join(root, "new.ts"),
  operation: "file.create",
  scope,
  ...(scope === "session" ? { session_id: session } : {}),
});
async function evaluate(ctx: unknown, op: unknown) {
  const { evaluateApproval } = await load();
  const result = await evaluateApproval(ctx, op);
  expect(ApprovalEvaluationSchema.safeParse(result).success).toBe(true);
  return result;
}
const matrix = [
  ["read-only", "file.read", "allow"],
  ["confirm", "file.read", "allow"],
  ["auto", "file.read", "allow"],
  ["read-only", "file.create", "deny"],
  ["confirm", "file.create", "ask"],
  ["auto", "file.create", "allow"],
  ["read-only", "file.overwrite", "deny"],
  ["confirm", "file.overwrite", "ask"],
  ["auto", "file.overwrite", "ask"],
  ["read-only", "file.delete", "deny"],
  ["confirm", "file.delete", "ask"],
  ["auto", "file.delete", "ask"],
  ["read-only", "shell", "deny"],
  ["confirm", "shell", "ask"],
  ["auto", "shell", "ask"],
] as const;
describe("approval policy: owner-confirmed matrix and real filesystem boundaries", () => {
  it.each(matrix)("%s / %s => %s", async (mode, kind, decision) => {
    const op =
      kind === "shell"
        ? { kind, cwd: ".", command: "echo NEVER_EXECUTE" }
        : { kind, target: kind === "file.create" ? "new.ts" : "existing.ts" };
    expect(await evaluate(context(mode), op)).toMatchObject({ decision });
  });
  it("omitted mode is read-only even with a matching saved grant", async () => {
    expect(
      await evaluate(context(undefined, [grant()]), { kind: "file.create", target: "new.ts" }),
    ).toEqual({ decision: "deny", reason: "read_only" });
  });
  it("dangerous operations offer only single confirmation, creation offers all three scopes", async () => {
    for (const kind of ["file.overwrite", "file.delete", "shell"]) {
      const op =
        kind === "shell"
          ? { kind, cwd: ".", command: "NEVER_EXECUTE" }
          : { kind, target: "existing.ts" };
      expect(await evaluate(context("auto", [grant()]), op)).toMatchObject({
        decision: "ask",
        allowed_scopes: ["once"],
      });
    }
    expect(
      await evaluate(context("confirm"), { kind: "file.create", target: "new.ts" }),
    ).toMatchObject({ decision: "ask", allowed_scopes: ["once", "session", "permanent"] });
  });
  it("no reusable grant means each new assessment still asks; the evaluator never stores an approval", async () => {
    const ctx = context("confirm");
    for (let i = 0; i < 2; i++)
      expect(await evaluate(ctx, { kind: "file.create", target: "new.ts" })).toMatchObject({
        decision: "ask",
      });
    expect(ctx.grants).toEqual([]);
  });
  it.each(["session", "permanent"] as const)(
    "matching %s grant permits only the exact new-file target",
    async (scope) => {
      const ctx = context("confirm", [grant(scope)]);
      expect(await evaluate(ctx, { kind: "file.create", target: "./new.ts" })).toMatchObject({
        decision: "allow",
        reason: `${scope}_grant`,
        target: join(root, "new.ts"),
      });
      expect(await evaluate(ctx, { kind: "file.create", target: "new.ts-child" })).toMatchObject({
        decision: "ask",
      });
    },
  );
  it("session grants cannot cross session, project or root; permanent remains scoped to project/root", async () => {
    for (const patch of [
      { session_id: other },
      { project_id: other },
      { root: sibling },
      { target: join(root, "other.ts") },
    ]) {
      expect(
        await evaluate(context("confirm", [{ ...grant(), ...patch }]), {
          kind: "file.create",
          target: "new.ts",
        }),
      ).toMatchObject({ decision: "ask" });
    }
    expect(
      await evaluate(
        { ...context("confirm", [grant("permanent")]), session_id: other },
        { kind: "file.create", target: "new.ts" },
      ),
    ).toMatchObject({ decision: "allow", reason: "permanent_grant" });
    expect(
      await evaluate(
        { ...context("confirm", [grant("permanent")]), project_id: other },
        { kind: "file.create", target: "new.ts" },
      ),
    ).toMatchObject({ decision: "ask" });
  });
  it.each(["auto", "confirm"])(
    "declaring an existing file as create in %s never bypasses overwrite confirmation",
    async (mode) => {
      const grants = [{ ...grant(), target: join(root, "existing.ts") }];
      expect(
        await evaluate(context(mode, grants), { kind: "file.create", target: "existing.ts" }),
      ).toMatchObject({ decision: "ask", operation: "file.overwrite", allowed_scopes: ["once"] });
      expect(await readFile(join(root, "existing.ts"), "utf8")).toBe("unchanged");
    },
  );
  it("a saved creation rule cannot overwrite a file created since the last assessment", async () => {
    const ctx = context("confirm", [grant("permanent")]);
    expect(await evaluate(ctx, { kind: "file.create", target: "new.ts" })).toMatchObject({
      decision: "allow",
    });
    await writeFile(join(root, "new.ts"), "newly existing");
    expect(await evaluate(ctx, { kind: "file.create", target: "new.ts" })).toMatchObject({
      decision: "ask",
      operation: "file.overwrite",
    });
  });
  it.each(["../project-sibling/new.ts", "escape/new.ts"])(
    "rejects new-file escape %s",
    async (target) => {
      expect(await evaluate(context("auto"), { kind: "file.create", target })).toEqual({
        decision: "deny",
        reason: "outside_root",
      });
    },
  );
  it.each(["../project-sibling/private.ts", "escape/private.ts"])(
    "read cannot escape through %s",
    async (target) => {
      expect(await evaluate(context("auto"), { kind: "file.read", target })).toEqual({
        decision: "deny",
        reason: "outside_root",
      });
    },
  );
  it("absolute sibling paths are not trusted by a string-prefix coincidence", async () => {
    expect(
      await evaluate(context("auto"), { kind: "file.create", target: join(sibling, "new.ts") }),
    ).toEqual({ decision: "deny", reason: "outside_root" });
    expect(
      await evaluate(context("auto"), { kind: "shell", cwd: sibling, command: "private command" }),
    ).toEqual({ decision: "deny", reason: "outside_root" });
  });
  it("canonicalizes in-root aliases and relative segments before matching grants", async () => {
    const target = join(root, "sub", "new.ts"),
      ctx = context("confirm", [{ ...grant(), target }]);
    expect(
      await evaluate(ctx, { kind: "file.create", target: "alias/../sub/new.ts" }),
    ).toMatchObject({ decision: "allow", target });
    expect(
      await evaluate(context("auto"), { kind: "file.read", target: "file-link.ts" }),
    ).toMatchObject({ decision: "allow", target: join(root, "existing.ts") });
    expect(
      await evaluate(context("auto"), { kind: "file.create", target: "file-link.ts" }),
    ).toMatchObject({ decision: "ask", operation: "file.overwrite" });
  });
  it("a symlink supplied as trusted root resolves to the same canonical scope", async () => {
    const alias = join(base, "root-alias");
    await symlink(root, alias);
    expect(
      await evaluate(
        { ...context("confirm", [grant()]), root: alias },
        { kind: "file.create", target: join(alias, "new.ts") },
      ),
    ).toMatchObject({ decision: "allow", target: join(root, "new.ts") });
  });
  it.each(["broken", "absent-parent/new.ts"])(
    "does not treat unresolved %s as a safe new file",
    async (target) => {
      expect(await evaluate(context("auto"), { kind: "file.create", target })).toEqual({
        decision: "deny",
        reason: "invalid_target",
      });
    },
  );
  it("symlink loops fail closed without raw filesystem errors", async () => {
    await symlink("loop-b", join(root, "loop-a"));
    await symlink("loop-a", join(root, "loop-b"));
    expect(await evaluate(context("auto"), { kind: "file.create", target: "loop-a" })).toEqual({
      decision: "deny",
      reason: "invalid_target",
    });
  });
  it("canonical target paths reached via innocent aliases must satisfy the path contract too", async () => {
    const hidden = join(root, "hidden\nfolder");
    await mkdir(hidden);
    await writeFile(join(hidden, "file.ts"), "unchanged");
    await symlink(hidden, join(root, "clean-alias"));
    for (const op of [
      { kind: "file.read", target: "clean-alias/file.ts" },
      { kind: "file.create", target: "clean-alias/new.ts" },
    ])
      expect(await evaluate(context("auto"), op)).toEqual({
        decision: "deny",
        reason: "invalid_target",
      });
  });
  it("a canonical root with control characters cannot bypass validation through an alias", async () => {
    const hidden = join(base, "hidden\nroot"),
      alias = join(base, "clean-root");
    await mkdir(hidden);
    await symlink(hidden, alias);
    expect(
      await evaluate(
        { ...context("auto"), root: alias },
        { kind: "file.create", target: "new.ts" },
      ),
    ).toEqual({ decision: "deny", reason: "invalid_root" });
  });
  it("invalid roots fail closed (relative, missing, file, filesystem root)", async () => {
    for (const invalid of [
      "relative",
      join(base, "missing"),
      join(root, "existing.ts"),
      parse(root).root,
    ])
      expect(
        await evaluate(
          { ...context("auto"), root: invalid },
          { kind: "file.create", target: "new.ts" },
        ),
      ).toEqual({ decision: "deny", reason: "invalid_root" });
  });
  it("directories cannot be disguised as files and the trusted root itself cannot be deleted", async () => {
    for (const kind of ["file.read", "file.create", "file.overwrite"]) {
      expect(await evaluate(context("auto"), { kind, target: "sub" })).toEqual({
        decision: "deny",
        reason: "invalid_target",
      });
    }
    expect(await evaluate(context("auto"), { kind: "file.delete", target: "." })).toEqual({
      decision: "deny",
      reason: "invalid_target",
    });
    expect(await evaluate(context("auto"), { kind: "file.delete", target: "sub" })).toMatchObject({
      decision: "ask",
      allowed_scopes: ["once"],
    });
  });
  it("missing read/overwrite/delete targets are denied instead of silently becoming creates", async () => {
    for (const kind of ["file.read", "file.overwrite", "file.delete"])
      expect(await evaluate(context("auto"), { kind, target: "absent" })).toEqual({
        decision: "deny",
        reason: "invalid_target",
      });
  });
  it("malformed context, grants and requests never imply permission", async () => {
    for (const ctx of [
      null,
      { ...context("auto"), mode: "unrestricted" },
      { ...context("auto"), grants: [{ ...grant(), operation: "shell" }] },
      { ...context("auto"), grants: [{ ...grant(), scope: "once" }] },
    ])
      expect(await evaluate(ctx, { kind: "file.create", target: "new.ts" })).toEqual({
        decision: "deny",
        reason: "invalid_request",
      });
    for (const op of [
      null,
      { kind: "file.create", target: "new.ts", confirm: true },
      { kind: "file.create", target: "bad\0path" },
      { kind: "shell", cwd: ".", command: "" },
    ])
      expect(await evaluate(context("auto"), op)).toEqual({
        decision: "deny",
        reason: "invalid_request",
      });
  });
  it("assessment only: no filesystem modifications, commands, grant mutations or private payload echo", async () => {
    const ctx = context("auto", [grant()]),
      before = structuredClone(ctx),
      files = await readdir(root);
    const result = await evaluate(ctx, {
      kind: "shell",
      cwd: ".",
      command: `touch ${join(root, "MUST_NOT_EXIST")} # secret command`,
    });
    expect(result).toMatchObject({ decision: "ask" });
    expect(JSON.stringify(result)).not.toContain("secret command");
    await evaluate(ctx, { kind: "file.create", target: "new.ts" });
    await evaluate(ctx, { kind: "file.delete", target: "existing.ts" });
    expect(await readdir(root)).toEqual(files);
    expect(ctx).toEqual(before);
    expect(await readFile(join(root, "existing.ts"), "utf8")).toBe("unchanged");
    expect((await lstat(join(root, "escape"))).isSymbolicLink()).toBe(true);
  });
});
