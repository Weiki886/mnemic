import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ReusableApprovalGrantSchema, type ReusableApprovalGrant } from "@mnemic/shared/approval";

export interface StoredApproval {
  id: string;
  grant: ReusableApprovalGrant;
}
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const failure = () => new Error("审批授权存储不可用；请检查私有目录、权限或损坏记录。");

/** Local, user-owned policy data, never a sandbox against another process with the same UID. */
export class ApprovalStore {
  constructor(readonly directory = join(homedir(), ".mnemic-approvals")) {}

  private async ready(create = false): Promise<boolean> {
    if (!isAbsolute(this.directory)) throw failure();
    if (create) {
      try {
        await mkdir(this.directory, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
          throw failure();
      }
    }
    try {
      const entry = await lstat(this.directory);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        (entry.mode & 0o077) !== 0 ||
        (process.getuid && entry.uid !== process.getuid())
      )
        throw failure();
      return true;
    } catch (error) {
      if (!create && missing(error)) return false;
      throw failure();
    }
  }

  private async read(id: string): Promise<StoredApproval> {
    const file = await open(
      join(this.directory, `${id}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const entry = await file.stat();
      if (
        !entry.isFile() ||
        entry.nlink !== 1 ||
        entry.size > 32_768 ||
        (entry.mode & 0o077) !== 0 ||
        (process.getuid && entry.uid !== process.getuid())
      )
        throw failure();
      const grant = ReusableApprovalGrantSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (
        grant.scope !== "permanent" ||
        !isAbsolute(grant.root) ||
        !isAbsolute(grant.target) ||
        resolve(grant.root) !== grant.root ||
        resolve(grant.target) !== grant.target
      )
        throw failure();
      return { id, grant };
    } finally {
      await file.close();
    }
  }

  async list(): Promise<StoredApproval[]> {
    try {
      if (!(await this.ready())) return [];
      const names = await readdir(this.directory);
      if (names.length > 2000) throw failure();
      const ids = names
        .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
        .map((name) => name.slice(0, -5));
      if (ids.length > 1000) throw failure();
      const rows: StoredApproval[] = [];
      for (const id of ids.sort()) {
        try {
          rows.push(await this.read(id));
        } catch (error) {
          if (!missing(error)) throw error;
        } // concurrent revoke
      }
      return rows;
    } catch {
      throw failure();
    }
  }

  async add(input: unknown): Promise<string> {
    const grant = ReusableApprovalGrantSchema.parse(input);
    if (
      grant.scope !== "permanent" ||
      !isAbsolute(grant.root) ||
      !isAbsolute(grant.target) ||
      resolve(grant.root) !== grant.root ||
      resolve(grant.target) !== grant.target
    )
      throw failure();
    if ((await this.list()).length >= 1000) throw failure();
    await this.ready(true);
    const id = randomUUID(),
      temp = join(this.directory, `.${id}.tmp`);
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(grant));
        await file.sync();
      } finally {
        await file.close();
      }
      // Publish a complete record without replacing another process's grant.
      await link(temp, join(this.directory, `${id}.json`));
    } catch {
      throw failure();
    } finally {
      await unlink(temp).catch(() => {});
    }
    return id;
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(id)) throw failure();
    if (!(await this.ready())) return;
    try {
      await this.read(id);
      await unlink(join(this.directory, `${id}.json`));
    } catch (error) {
      if (!missing(error)) throw failure();
    }
  }
}
