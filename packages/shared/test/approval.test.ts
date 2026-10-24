import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

async function load() {
  const url = new URL("../src/approval.ts", import.meta.url);
  expect(existsSync(url), "approval contract entry must exist").toBe(true);
  return import(url.href) as Promise<typeof import("../src/approval.js")>;
}
const project = "01920000-0000-7000-8000-000000000001";
const session = "01920000-0000-7000-8000-000000000002";
const context = { project_id: project, session_id: session, root: "/workspace/project" };
const grant = {
  project_id: project,
  root: context.root,
  target: "/workspace/project/new.ts",
  operation: "file.create",
  scope: "permanent",
};
describe("approval policy contracts (#34 part 1)", () => {
  it("defaults only omitted mode to read-only and rejects unknown permission settings", async () => {
    const { ApprovalContextSchema } = await load();
    expect(ApprovalContextSchema.parse(context)).toEqual({
      ...context,
      mode: "read-only",
      grants: [],
    });
    for (const mode of ["read-only", "confirm", "auto"])
      expect(ApprovalContextSchema.parse({ ...context, mode }).mode).toBe(mode);
    for (const value of [
      { ...context, mode: "" },
      { ...context, mode: null },
      { ...context, mode: "unrestricted" },
      { ...context, project_id: "bad" },
      { ...context, bypass: true },
    ])
      expect(ApprovalContextSchema.safeParse(value).success).toBe(false);
  });
  it("accepts explicit file operations and shell metadata, without executable payloads on file requests", async () => {
    const { ApprovalOperationSchema } = await load();
    for (const kind of ["file.read", "file.create", "file.overwrite", "file.delete"])
      expect(ApprovalOperationSchema.parse({ kind, target: "src/a.ts" })).toEqual({
        kind,
        target: "src/a.ts",
      });
    expect(
      ApprovalOperationSchema.parse({ kind: "shell", cwd: ".", command: 'echo "hello"' }),
    ).toMatchObject({ kind: "shell" });
    for (const value of [
      { kind: "file.create", target: "a", contents: "private" },
      { kind: "file.create", target: "a", confirm: true },
      { kind: "file.write", target: "a" },
      { kind: "file.read", target: "" },
      { kind: "file.read", target: "a\u0000b" },
      { kind: "file.read", target: "a\u202eb" },
      { kind: "shell", cwd: ".", command: " " },
      { kind: "shell", cwd: ".", command: "a\u0000b" },
    ])
      expect(ApprovalOperationSchema.safeParse(value).success).toBe(false);
  });
  it("only stores reusable exact create grants, with session identity mandatory for session grants", async () => {
    const { ReusableApprovalGrantSchema } = await load();
    expect(ReusableApprovalGrantSchema.parse(grant)).toEqual(grant);
    expect(
      ReusableApprovalGrantSchema.parse({ ...grant, scope: "session", session_id: session }),
    ).toMatchObject({ session_id: session });
    for (const value of [
      { ...grant, scope: "once" },
      { ...grant, scope: "session" },
      { ...grant, scope: "permanent", session_id: session },
      { ...grant, operation: "file.delete" },
      { ...grant, operation: "file.overwrite" },
      { ...grant, operation: "shell" },
      { ...grant, recursive: true },
    ])
      expect(ReusableApprovalGrantSchema.safeParse(value).success).toBe(false);
  });
  it("serializes bounded decisions without raw command, contents or arbitrary error details", async () => {
    const { ApprovalEvaluationSchema } = await load();
    const question = {
      decision: "ask",
      reason: "confirmation_required",
      operation: "shell",
      target: "/workspace/project",
      allowed_scopes: ["once"],
    };
    expect(ApprovalEvaluationSchema.parse(question)).toEqual(question);
    for (const value of [
      { decision: "deny", reason: "outside_root" },
      {
        decision: "allow",
        reason: "auto_create",
        operation: "file.create",
        target: "/workspace/project/a",
      },
    ])
      expect(ApprovalEvaluationSchema.safeParse(value).success).toBe(true);
    for (const value of [
      { ...question, command: "private" },
      { ...question, allowed_scopes: ["session"] },
      {
        decision: "allow",
        reason: "auto_create",
        operation: "shell",
        target: "/workspace/project",
      },
      { decision: "deny", reason: "outside_root", error: "raw fs detail" },
      { decision: "allow", reason: "anything", operation: "shell", target: "." },
    ])
      expect(ApprovalEvaluationSchema.safeParse(value).success).toBe(false);
  });
});
