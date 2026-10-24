import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApprovalAuditEventSchema,
  type ApprovalAuditEvent,
} from "../../../packages/shared/src/approval-audit.js";
import { ApprovalController } from "../src/approval-controller.js";
import { ApprovalStore } from "../src/approval-store.js";
let base: string, root: string, store: ApprovalStore;
const controllers: ApprovalController[] = [],
  projectId = "01920000-0000-7000-8000-000000000001";
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mnemic-audit-")));
  root = join(base, "project");
  await mkdir(root);
  await writeFile(join(root, "old.ts"), "unchanged");
  store = new ApprovalStore(join(base, "grants"));
});
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.dispose());
  await rm(base, { recursive: true, force: true });
});
async function create(mode = "confirm", audit = vi.fn(async (_event: ApprovalAuditEvent) => {})) {
  const c = await ApprovalController.create({ projectId, root, mode, store, audit });
  controllers.push(c);
  return { c, audit };
}
const op = { kind: "file.create", target: "new.ts" };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
async function prompt(c: ApprovalController) {
  await vi.waitFor(() => expect(c.pending).not.toBeNull());
  return c.pending!;
}
it("logs policy allow and deny with UUID correlation and digest-only targets", async () => {
  const { c, audit } = await create("read-only");
  await c.request(op);
  await c.request({ kind: "file.read", target: "old.ts" });
  expect(audit).toHaveBeenCalledTimes(2);
  const [denied, allowed] = audit.mock.calls.map(([e]) => ApprovalAuditEventSchema.parse(e));
  expect(denied).toMatchObject({
    project_id: projectId,
    mode: "read-only",
    decision: "deny",
    reason: "read_only",
    target_hash: hash("new.ts"),
    root_hash: hash(root),
    target_basis: "requested",
  });
  expect(allowed).toMatchObject({
    decision: "allow",
    reason: "read_allowed",
    target_hash: hash(join(root, "old.ts")),
    target_basis: "canonical",
  });
  expect(denied!.request_id).not.toBe(allowed!.request_id);
  expect(JSON.stringify(audit.mock.calls)).not.toContain(root);
});
it("no policy approval is returned when audit fails", async () => {
  const audit = vi.fn(async (_e: ApprovalAuditEvent) => {
    throw new Error("secret upstream error");
  });
  const { c } = await create("auto", audit);
  expect(await c.request(op)).toEqual({ approved: false, reason: "audit_error" });
});
it.each(["session", "permanent"] as const)(
  "audit failure never publishes a newly approved %s grant",
  async (scope) => {
    const { c } = await create(
      "confirm",
      vi.fn(async (_e: ApprovalAuditEvent) => {
        throw new Error("offline");
      }),
    );
    const request = c.request(op);
    await c.answer((await prompt(c)).id, scope);
    expect(await request).toEqual({ approved: false, reason: "audit_error" });
    expect(await c.list()).toEqual([]);
  },
);
it("approval stays pending until receipt; concurrent requests are denied and logged", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const audit = vi.fn(async (e: ApprovalAuditEvent) => {
    if (e.decision === "allow") await gate;
  });
  const { c } = await create("auto", audit);
  let settled = false;
  const request = c.request(op).then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(c.busy).toBe(true);
  expect(await c.request(op)).toMatchObject({ approved: false, reason: "busy" });
  release();
  expect(await request).toMatchObject({ approved: true });
  expect(audit.mock.calls[1]![0].reason).toBe("busy");
});
it("mode changes while awaiting audit ACK cancel permission and append a linked denial", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const audit = vi.fn(async (e: ApprovalAuditEvent) => {
    if (e.decision === "allow") await gate;
  });
  const { c } = await create("auto", audit),
    request = c.request(op);
  await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
  c.setMode("read-only");
  release();
  expect(await request).toMatchObject({ approved: false, reason: "cancelled" });
  expect(audit).toHaveBeenCalledTimes(2);
  expect(audit.mock.calls[1]![0]).toMatchObject({
    request_id: audit.mock.calls[0]![0].request_id,
    decision: "deny",
    reason: "cancelled",
  });
});
it("human shell confirmation records once and only a command digest", async () => {
  const { c, audit } = await create(),
    command = "echo sk-DO_NOT_LOG\nsecond-line";
  const request = c.request({ kind: "shell", cwd: ".", command });
  await c.answer((await prompt(c)).id, "once");
  await request;
  expect(audit.mock.calls[0]![0]).toMatchObject({
    operation: "shell",
    decision: "allow",
    reason: "confirmed",
    scope: "once",
    command_hash: hash(command),
  });
  expect(JSON.stringify(audit.mock.calls)).not.toContain("DO_NOT_LOG");
});
it("caller mutation while confirming cannot substitute the displayed command in audit", async () => {
  const { c, audit } = await create();
  const input = { kind: "shell", cwd: ".", command: "echo APPROVED" };
  const request = c.request(input),
    p = await prompt(c);
  expect(p.command).toBe("echo APPROVED");
  input.command = "echo NOT_APPROVED";
  await c.answer(p.id, "once");
  expect(await request).toMatchObject({ approved: true });
  expect(audit.mock.calls[0]![0].command_hash).toBe(hash("echo APPROVED"));
});
it("caller mutation cannot replace the approved target during the request lifecycle", async () => {
  const { c, audit } = await create();
  const input = { kind: "file.create", target: "new.ts" },
    request = c.request(input),
    p = await prompt(c);
  input.kind = "file.delete";
  input.target = "old.ts";
  await c.answer(p.id, "once");
  expect(await request).toMatchObject({
    approved: true,
    evaluation: { operation: "file.create", target: join(root, "new.ts") },
  });
  expect(audit.mock.calls[0]![0]).toMatchObject({
    operation: "file.create",
    target_hash: hash(join(root, "new.ts")),
  });
});
it("mode cancellation queued after the last assessment still wins before approval commits", async () => {
  const { c, audit } = await create("auto");
  // Preserve real policy/FS work; only control the promise-resolution scheduling seam.
  const seam = c as unknown as { assess: (input: unknown) => Promise<unknown> };
  const original = seam.assess.bind(c);
  let checks = 0;
  vi.spyOn(seam, "assess").mockImplementation(
    (input) =>
      new Promise((resolve, reject) => {
        original(input).then((value) => {
          checks++;
          resolve(value);
          if (checks === 2) queueMicrotask(() => c.setMode("read-only"));
        }, reject);
      }),
  );
  const result = await c.request(op);
  expect(c.mode).toBe("read-only");
  expect(result).toMatchObject({ approved: false, reason: "cancelled" });
  expect(audit.mock.calls.at(-1)![0]).toMatchObject({ decision: "deny", reason: "cancelled" });
});
it("dispose drains the cancellation record; malformed/closed attempts contain no raw inputs", async () => {
  const { c, audit } = await create();
  await c.request({ kind: "secret-invalid-kind", target: "sk-SECRET" });
  const request = c.request(op);
  await prompt(c);
  c.dispose();
  await c.drain();
  expect(await request).toMatchObject({ approved: false, reason: "cancelled" });
  await c.request(op);
  expect(audit.mock.calls.map(([e]) => e.reason)).toEqual([
    "invalid_request",
    "cancelled",
    "closed",
  ]);
  expect(JSON.stringify(audit.mock.calls)).not.toContain("sk-SECRET");
});
it("shutdown also waits for an in-flight permanent write and its cancellation cleanup", async () => {
  const { c } = await create();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const add = store.add.bind(store);
  vi.spyOn(store, "add").mockImplementationOnce(async (value) => {
    entered();
    await gate;
    return add(value);
  });
  const request = c.request(op),
    p = await prompt(c),
    answer = c.answer(p.id, "permanent");
  await started;
  c.dispose();
  let drained = false;
  const drain = c.drain().then(() => {
    drained = true;
  });
  try {
    // Let settled microtasks run; a blocked write must still keep shutdown pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
  } finally {
    release();
    await answer;
    await drain;
  }
  expect(await request).toMatchObject({ approved: false, reason: "cancelled" });
  expect(await store.list()).toEqual([]);
});
it.each(["session", "permanent"] as const)(
  "%s grants are not reusable while audit acknowledgement is pending",
  async (scope) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const audit = vi.fn(async (_e: ApprovalAuditEvent) => {
      await gate;
    });
    const { c } = await create("confirm", audit),
      request = c.request(op);
    await c.answer((await prompt(c)).id, scope);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
    try {
      expect(await c.list()).toEqual([]);
    } finally {
      release();
      await request;
    }
  },
);
it("a target created while waiting for audit cannot inherit an automatic new-file permission", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const audit = vi.fn(async (e: ApprovalAuditEvent) => {
    if (e.decision === "allow") await gate;
  });
  const { c } = await create("auto", audit),
    request = c.request(op);
  await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
  await writeFile(join(root, "new.ts"), "appeared");
  release();
  expect(await request).toMatchObject({ approved: false, reason: "changed" });
});
