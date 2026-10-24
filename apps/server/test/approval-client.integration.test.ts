import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApiClient } from "@mnemic/shared";
import { ApprovalController } from "../../cli/src/approval-controller.js";
import { ApprovalStore } from "../../cli/src/approval-store.js";
import { createApprovalAuditSink, runApprovalHistory } from "../../cli/src/approval-audit.js";
import { buildApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db-helper.js";
let t: TestDb,
  app: ReturnType<typeof buildApp>,
  root: string,
  projectId: string,
  store: ApprovalStore;
const token = "approval-client-test-token-".repeat(2),
  controllers: ApprovalController[] = [];
const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const response = await app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST",
    url: url.pathname + url.search,
    headers: Object.fromEntries(new Headers(init?.headers)),
    ...(typeof init?.body === "string"
      ? { payload: JSON.parse(init.body) as Record<string, unknown> }
      : {}),
  });
  return new Response(response.body, { status: response.statusCode });
};
const api = () => createApiClient({ baseUrl: "http://approval.test", token, fetch });
beforeAll(async () => {
  t = await setupTestDb();
  app = buildApp({ db: t.db, authToken: token });
}, 180_000);
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mnemic-audit-e2e-")));
  store = new ApprovalStore(join(root, "grants"));
  projectId = randomUUID();
  await t.sql`insert into projects(id,name) values (${projectId},'approval client integration')`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) {
    c.dispose();
    await c.drain();
  }
  await t.sql`delete from audit_log where meta->>'project_id'=${projectId}`;
  await t.sql`delete from projects where id=${projectId}`;
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await app.close();
  await t.close();
});
async function create(mode = "confirm") {
  const c = await ApprovalController.create({
    projectId,
    root,
    mode,
    store,
    audit: createApprovalAuditSink(api(), projectId),
  });
  controllers.push(c);
  return c;
}
async function choose(
  c: ApprovalController,
  target: string,
  scope: "once" | "session" | "permanent" | "deny",
) {
  const request = c.request({ kind: "file.create", target });
  await vi.waitFor(() => expect(c.pending).not.toBeNull());
  await c.answer(c.pending!.id, scope);
  return request;
}
it("real HTTP contract and PG complete once/session/permanent/danger matrix and query history", async () => {
  const c = await create();
  expect((await choose(c, "once.ts", "once")).approved).toBe(true);
  expect((await choose(c, "once.ts", "deny")).approved).toBe(false);
  await choose(c, "session.ts", "session");
  expect(await c.request({ kind: "file.create", target: "session.ts" })).toMatchObject({
    approved: true,
    reason: "session_grant",
  });
  await choose(c, "permanent.ts", "permanent");
  const reopened = await create();
  expect(await reopened.request({ kind: "file.create", target: "permanent.ts" })).toMatchObject({
    approved: true,
    reason: "permanent_grant",
  });
  const readOnly = await create("read-only");
  expect(await readOnly.request({ kind: "file.create", target: "permanent.ts" })).toMatchObject({
    approved: false,
    reason: "read_only",
  });
  for (const mode of ["read-only", "confirm", "auto"]) {
    const controller = await create(mode),
      request = controller.request({
        kind: "shell",
        cwd: ".",
        command: `touch ${join(root, "MUST_NOT_EXECUTE")}`,
      });
    if (mode !== "read-only") {
      await vi.waitFor(() => expect(controller.pending).not.toBeNull());
      expect(await controller.answer(controller.pending!.id, "permanent")).toBe(false);
      await controller.answer(controller.pending!.id, "once");
    }
    expect((await request).approved).toBe(mode !== "read-only");
  }
  const rows = await t.sql`select * from audit_log where meta->>'project_id'=${projectId}`;
  expect(rows).toHaveLength(10);
  expect(
    rows.every(
      (r) =>
        r.actor === "cli" && r.action.startsWith("approval.") && r.meta.client_reported === true,
    ),
  ).toBe(true);
  const history = await runApprovalHistory(api(), projectId, { limit: 20, offset: 0 });
  expect(history).toContain("permanent_grant");
  expect(history).toContain("read_only");
  expect(JSON.stringify(rows)).not.toContain(root);
  expect(JSON.stringify(rows)).not.toContain("MUST_NOT_EXECUTE");
  expect(existsSync(join(root, "once.ts"))).toBe(false);
  expect(existsSync(join(root, "MUST_NOT_EXECUTE"))).toBe(false);
});
it("a database failure cannot leave a newly approved permanent grant", async () => {
  const c = await create();
  vi.spyOn(t.db, "insert").mockImplementationOnce(() => {
    throw new Error("audit database unavailable");
  });
  expect(await choose(c, "new.ts", "permanent")).toEqual({
    approved: false,
    reason: "audit_error",
  });
  expect(await store.list()).toEqual([]);
  expect(await t.sql`select id from audit_log where meta->>'project_id'=${projectId}`).toHaveLength(
    0,
  );
});
