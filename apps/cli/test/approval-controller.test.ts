import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalStore } from "../src/approval-store.js";

const projectId = "01920000-0000-7000-8000-000000000001";
const nextId = "01920000-0000-7000-8000-000000000002";
let base: string, root: string, store: ApprovalStore;
const controllers: Array<{ dispose(): void }> = [];
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mnemic-controller-")));
  root = join(base, "project");
  await mkdir(root);
  await writeFile(join(root, "old.ts"), "unchanged");
  store = new ApprovalStore(join(base, "grants"));
});
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.dispose());
  await rm(base, { recursive: true, force: true });
});
async function create(mode = "confirm", id = projectId) {
  expect(existsSync(new URL("../src/approval-controller.ts", import.meta.url))).toBe(true);
  const { ApprovalController } = await import("../src/approval-controller.js");
  const c = await ApprovalController.create({ projectId: id, root, mode, store });
  controllers.push(c);
  return c;
}
const op = { kind: "file.create", target: "new.ts" };
async function prompt(c: Awaited<ReturnType<typeof create>>) {
  await vi.waitFor(() => expect(c.pending).not.toBeNull());
  return c.pending!;
}
it("default mode is read-only; reads remain available, writes never ask or persist", async () => {
  const { ApprovalController } = await import("../src/approval-controller.js");
  const c = await ApprovalController.create({ projectId, root, store });
  controllers.push(c);
  expect(c.mode).toBe("read-only");
  expect(await c.request(op)).toMatchObject({ approved: false, reason: "read_only" });
  expect(await c.request({ kind: "file.read", target: "old.ts" })).toMatchObject({
    approved: true,
  });
  expect(c.pending).toBeNull();
  expect(await store.list()).toEqual([]);
});
it("once is consumed by exactly one request; stale/repeated answers cannot approve the next", async () => {
  const c = await create(),
    first = c.request(op),
    p = await prompt(c);
  expect(await c.answer(p.id, "once")).toBe(true);
  expect(await first).toMatchObject({ approved: true, reason: "confirmed" });
  const second = c.request(op),
    p2 = await prompt(c);
  expect(p2.id).not.toBe(p.id);
  expect(await c.answer(p.id, "once")).toBe(false);
  await c.answer(p2.id, "deny");
  expect(await second).toMatchObject({ approved: false });
  expect(await store.list()).toEqual([]);
});
it("session grant matches canonical target only and is cleared on conversation switch", async () => {
  const c = await create(),
    first = c.request(op),
    p = await prompt(c);
  await c.answer(p.id, "session");
  await first;
  expect(await c.request(op)).toMatchObject({ approved: true, reason: "session_grant" });
  const other = c.request({ ...op, target: "different.ts" });
  await c.answer((await prompt(c)).id, "deny");
  await other;
  c.setSession(nextId);
  expect(await c.list()).toEqual([]);
  const next = c.request(op);
  await c.answer((await prompt(c)).id, "deny");
  expect(await next).toMatchObject({ approved: false });
  expect(await store.list()).toEqual([]);
});
it("permanent grant survives reopening, remains project-scoped and is revoked across instances", async () => {
  const c = await create(),
    first = c.request(op);
  await c.answer((await prompt(c)).id, "permanent");
  await first;
  const b = await create();
  expect(await b.request(op)).toMatchObject({ approved: true, reason: "permanent_grant" });
  const otherProject = await create("confirm", nextId),
    other = otherProject.request(op);
  await otherProject.answer((await prompt(otherProject)).id, "deny");
  await other;
  const [row] = await c.list();
  await c.revoke(row!.id);
  const next = b.request(op);
  await b.answer((await prompt(b)).id, "deny");
  expect(await next).toMatchObject({ approved: false });
});
it.each(["file.delete", "file.overwrite", "shell"])(
  "%s only accepts once, even in auto",
  async (kind) => {
    const c = await create("auto");
    const operation =
      kind === "shell"
        ? { kind, cwd: ".", command: "echo not-executed" }
        : { kind, target: "old.ts" };
    const request = c.request(operation),
      p = await prompt(c);
    expect(p.evaluation.allowed_scopes).toEqual(["once"]);
    expect(await c.answer(p.id, "permanent")).toBe(false);
    expect(c.pending?.id).toBe(p.id);
    await c.answer(p.id, "once");
    expect(await request).toMatchObject({ approved: true });
    const again = c.request(operation);
    await c.answer((await prompt(c)).id, "deny");
    await again;
    expect(await store.list()).toEqual([]);
  },
);
it("a target created while asking cannot turn a creation consent into overwrite consent", async () => {
  const c = await create(),
    request = c.request(op),
    p = await prompt(c);
  await writeFile(join(root, "new.ts"), "appeared");
  await c.answer(p.id, "permanent");
  expect(await request).toMatchObject({ approved: false, reason: "changed" });
  expect(await store.list()).toEqual([]);
});
it.each(["mode", "session", "dispose"])(
  "%s change cancels pending approval and invalidates its ID",
  async (action) => {
    const c = await create(),
      request = c.request(op),
      p = await prompt(c);
    if (action === "mode") c.setMode("auto");
    else if (action === "session") c.setSession(nextId);
    else c.dispose();
    expect(await request).toMatchObject({ approved: false });
    expect(await c.answer(p.id, "once")).toBe(false);
  },
);
it("concurrent request is denied without replacing the visible prompt", async () => {
  const c = await create(),
    first = c.request(op),
    p = await prompt(c);
  expect(await c.request({ ...op, target: "other.ts" })).toMatchObject({
    approved: false,
    reason: "busy",
  });
  expect(c.pending?.id).toBe(p.id);
  await c.answer(p.id, "deny");
  await first;
});
it("storage failure cannot report permission granted or expose raw filesystem errors", async () => {
  const c = await create(),
    first = c.request(op),
    p = await prompt(c);
  await writeFile(store.directory, "block storage");
  await c.answer(p.id, "permanent");
  expect(await first).toEqual({ approved: false, reason: "storage_error" });
});
it("read-only overrides existing reusable grants; invalid modes do not change it", async () => {
  const c = await create(),
    first = c.request(op);
  await c.answer((await prompt(c)).id, "session");
  await first;
  c.setMode("read-only");
  expect(() => c.setMode("unrestricted")).toThrow();
  expect(await c.request(op)).toMatchObject({ approved: false, reason: "read_only" });
});
it("file changes during permanent persistence cancel consent and remove the newly saved rule", async () => {
  const c = await create(),
    first = c.request(op),
    p = await prompt(c);
  const add = store.add.bind(store);
  vi.spyOn(store, "add").mockImplementation(async (value) => {
    const id = await add(value);
    await writeFile(join(root, "new.ts"), "appeared while persisting");
    return id;
  });
  await c.answer(p.id, "permanent");
  expect(await first).toMatchObject({ approved: false, reason: "changed" });
  expect(await store.list()).toEqual([]);
});
it("a caller cannot mutate session authorization by editing a listed record", async () => {
  const c = await create(),
    first = c.request(op);
  await c.answer((await prompt(c)).id, "session");
  await first;
  const [row] = await c.list();
  row!.grant.target = join(root, "not-approved.ts");
  const request = c.request({ ...op, target: "not-approved.ts" });
  await c.answer((await prompt(c)).id, "deny");
  expect(await request).toMatchObject({ approved: false });
});
it("mode changes while metadata is loading cannot produce a late prompt or permission", async () => {
  const c = await create();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(store, "list").mockImplementationOnce(async () => {
    await gate;
    return [];
  });
  const request = c.request(op);
  c.setMode("auto");
  release();
  expect(await request).toEqual({ approved: false, reason: "cancelled" });
  expect(c.pending).toBeNull();
});
it("repeated confirmation while rechecking cannot create duplicate permanent records", async () => {
  const c = await create(),
    request = c.request(op),
    p = await prompt(c);
  const results = await Promise.all([c.answer(p.id, "permanent"), c.answer(p.id, "permanent")]);
  expect(results).toEqual([true, false]);
  expect(await request).toMatchObject({ approved: true });
  expect(await store.list()).toHaveLength(1);
});
it("a failed post-publication check rolls back the permanent record before returning denied", async () => {
  const c = await create(),
    request = c.request(op),
    p = await prompt(c);
  const add = store.add.bind(store);
  vi.spyOn(store, "add").mockImplementationOnce(async (value) => {
    const id = await add(value);
    vi.spyOn(store, "list").mockRejectedValueOnce(new Error("temporary list failure"));
    return id;
  });
  await c.answer(p.id, "permanent");
  expect(await request).toEqual({ approved: false, reason: "storage_error" });
  expect(await store.list()).toEqual([]);
  const again = c.request(op);
  await c.answer((await prompt(c)).id, "deny");
  expect(await again).toMatchObject({ approved: false });
});
