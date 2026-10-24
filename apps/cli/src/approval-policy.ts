import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  ApprovalContextSchema,
  ApprovalOperationSchema,
  type ApprovalEvaluation,
  type ApprovalOperation,
} from "@mnemic/shared/approval";

type Denial = Extract<ApprovalEvaluation, { decision: "deny" }>;
type Target = { operation: ApprovalOperation["kind"]; target: string };
const deny = (reason: Denial["reason"]): Denial => ({ decision: "deny", reason });

function within(root: string, target: string): boolean {
  const rest = relative(root, target);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

/** Metadata only. Absent final entries need an existing real parent; dangling links are NOT absent. */
async function inspectTarget(root: string, operation: ApprovalOperation): Promise<Target | Denial> {
  const input = resolve(root, operation.kind === "shell" ? operation.cwd : operation.target);
  let exists = true;
  try {
    await lstat(input);
  } catch (error) {
    if (
      operation.kind !== "file.create" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    exists = false;
  }
  if (!exists) {
    const parent = await realpath(dirname(input));
    if (!within(root, parent)) return deny("outside_root");
    if (!(await stat(parent)).isDirectory()) return deny("invalid_target");
    return { operation: "file.create", target: join(parent, basename(input)) };
  }
  const target = await realpath(input);
  if (!within(root, target)) return deny("outside_root");
  const entry = await stat(target);
  if (operation.kind === "shell")
    return entry.isDirectory() ? { operation: "shell", target } : deny("invalid_target");
  if (operation.kind === "file.delete")
    return target !== root && (entry.isFile() || entry.isDirectory())
      ? { operation: operation.kind, target }
      : deny("invalid_target");
  if (!entry.isFile()) return deny("invalid_target");
  // Never trust a caller's "create" label as proof that an overwrite is harmless.
  return {
    operation: operation.kind === "file.create" ? "file.overwrite" : operation.kind,
    target,
  };
}

/**
 * Policy assessment, NOT an execution capability or sandbox. Only a trusted local controller may
 * supply context/grants. Future executors must revalidate and use exclusive create/no-follow checks
 * at the actual syscall: this metadata snapshot cannot close TOCTOU races.
 */
export async function evaluateApproval(
  context: unknown,
  request: unknown,
): Promise<ApprovalEvaluation> {
  const parsedContext = ApprovalContextSchema.safeParse(context);
  const parsedOperation = ApprovalOperationSchema.safeParse(request);
  if (!parsedContext.success || !parsedOperation.success) return deny("invalid_request");
  const ctx = parsedContext.data;
  let root: string;
  try {
    if (!isAbsolute(ctx.root)) return deny("invalid_root");
    root = await realpath(ctx.root);
    if (root === parse(root).root || !(await stat(root)).isDirectory()) return deny("invalid_root");
  } catch {
    return deny("invalid_root");
  }
  let target: Target | Denial;
  try {
    target = await inspectTarget(root, parsedOperation.data);
  } catch {
    // No raw path/error/command text in failures, including EACCES, dangling links and loops.
    return deny("invalid_target");
  }
  if ("decision" in target) return target;
  if (target.operation === "file.read")
    return { decision: "allow", reason: "read_allowed", ...target };
  if (ctx.mode === "read-only") return deny("read_only");
  if (target.operation !== "file.create")
    return {
      decision: "ask",
      reason: "confirmation_required",
      ...target,
      allowed_scopes: ["once"],
    };
  if (ctx.mode === "auto") return { decision: "allow", reason: "auto_create", ...target };
  const grant = ctx.grants.find(
    (rule) =>
      rule.project_id === ctx.project_id &&
      rule.root === root &&
      rule.target === target.target &&
      rule.operation === target.operation &&
      (rule.scope === "permanent" || rule.session_id === ctx.session_id),
  );
  if (grant)
    return {
      decision: "allow",
      reason: grant.scope === "session" ? "session_grant" : "permanent_grant",
      ...target,
    };
  return {
    decision: "ask",
    reason: "confirmation_required",
    ...target,
    allowed_scopes: ["once", "session", "permanent"],
  };
}
