import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync } from "node:fs";

let base: string, directory: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mnemic-grants-")));
  directory = join(base, "approvals");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});
async function store() {
  expect(existsSync(new URL("../src/approval-store.ts", import.meta.url))).toBe(true);
  const { ApprovalStore } = await import("../src/approval-store.js");
  return new ApprovalStore(directory);
}
const grant = () => ({
  project_id: "01920000-0000-7000-8000-000000000001",
  root: base,
  target: join(base, "new.ts"),
  operation: "file.create" as const,
  scope: "permanent" as const,
});
it("reads missing store without creating a directory", async () => {
  expect(await (await store()).list()).toEqual([]);
  expect(existsSync(directory)).toBe(false);
});
it("reopens permanent grants with private permissions and revokes by generated ID", async () => {
  const a = await store(),
    id = await a.add(grant());
  expect(await (await store()).list()).toEqual([{ id, grant: grant() }]);
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(directory, `${id}.json`))).mode & 0o777).toBe(0o600);
  await a.remove(id);
  expect(await a.list()).toEqual([]);
});
it("independent concurrent additions do not overwrite each other", async () => {
  const a = await store(),
    b = await store();
  await Promise.all([a.add(grant()), b.add({ ...grant(), target: join(base, "other.ts") })]);
  expect(await a.list()).toHaveLength(2);
});
it.each(["session", "once"])("rejects %s persistence without creating the store", async (scope) => {
  await expect((await store()).add({ ...grant(), scope })).rejects.toThrow();
  expect(existsSync(directory)).toBe(false);
});
it("corrupt or overly broad files never become silently accepted permissions", async () => {
  const s = await store(),
    id = await s.add(grant()),
    file = join(directory, `${id}.json`);
  await writeFile(file, "{invalid-json");
  await expect(s.list()).rejects.toThrow();
  await writeFile(file, JSON.stringify({ ...grant(), operation: "shell" }));
  await expect(s.list()).rejects.toThrow();
});
it("rejects symlink storage directory without changing its referent", async () => {
  const outside = join(base, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, directory);
  await expect((await store()).add(grant())).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
});
it("rejects linked grant files and never reads or deletes the referent", async () => {
  const s = await store(),
    id = await s.add(grant());
  const file = join(directory, `${id}.json`),
    outside = join(base, "private");
  await writeFile(outside, "secret", { mode: 0o600 });
  await rm(file);
  await symlink(outside, file);
  await expect(s.list()).rejects.toThrow();
  await expect(s.remove(id)).rejects.toThrow();
  expect(await readFile(outside, "utf8")).toBe("secret");
});
it("rejects broadly writable storage and files instead of repairing them silently", async () => {
  const s = await store(),
    id = await s.add(grant());
  await chmod(join(directory, `${id}.json`), 0o644);
  await expect(s.list()).rejects.toThrow();
  await chmod(directory, 0o755);
  await expect(s.add(grant())).rejects.toThrow();
});
it("revoke accepts UUIDs only; unrelated files are untouched", async () => {
  const s = await store();
  await s.add(grant());
  await expect(s.remove("../private")).rejects.toThrow();
  expect(await s.list()).toHaveLength(1);
});
