import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFileContext } from "../src/file-context.js";

const boundary = vi.hoisted(() => ({ beforeOpen: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const hook = boundary.beforeOpen;
      boundary.beforeOpen = undefined;
      await hook?.();
      return fs.open(...args);
    },
  };
});

let base: string, root: string, outside: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mnemic35-race-")));
  root = join(base, "project");
  outside = join(base, "other");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "src", "file.txt"), "PROJECT_TEXT");
  await writeFile(join(outside, "file.txt"), "OUTSIDE_SECRET");
});
afterEach(async () => {
  boundary.beforeOpen = undefined;
  await rm(base, { recursive: true, force: true });
});

describe("filesystem identity changes at the open boundary", () => {
  it("refuses a final entry replaced by an external symlink after metadata validation", async () => {
    boundary.beforeOpen = async () => {
      await rename(join(root, "src", "file.txt"), join(root, "src", "old.txt"));
      await symlink(join(outside, "file.txt"), join(root, "src", "file.txt"));
    };
    await expect(loadFileContext(root, "@src/file.txt")).rejects.toMatchObject({
      code: "unavailable",
    });
  });
  it("refuses an ancestor swapped to an external symlink even though the final entry is regular", async () => {
    boundary.beforeOpen = async () => {
      await rename(join(root, "src"), join(root, "old-src"));
      await symlink(outside, join(root, "src"));
    };
    await expect(loadFileContext(root, "@src/file.txt")).rejects.toMatchObject({ code: "changed" });
  });
  it("refuses an in-place change between metadata validation and opening", async () => {
    boundary.beforeOpen = async () => {
      await writeFile(join(root, "src", "file.txt"), "a different and longer revision");
    };
    await expect(loadFileContext(root, "@src/file.txt")).rejects.toMatchObject({ code: "changed" });
  });
});
