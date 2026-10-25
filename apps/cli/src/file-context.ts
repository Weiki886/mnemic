import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, posix, relative, sep } from "node:path";
import { ApprovalPathSchema } from "@mnemic/shared/approval";
import { isBlockedProjectPath as blocked } from "@mnemic/shared/file-context";
import {
  FileReferenceError,
  normalizeReferencePath,
  parseFileReferences,
  type FileReferenceErrorCode,
} from "./file-references.js";

/** Implementation limits, not model token counts or a filesystem sandbox. */
export const FILE_CONTEXT_LIMITS = Object.freeze({
  fileBytes: 16_384,
  totalBytes: 65_536,
  files: 8,
  directoryEntries: 200,
  keyFilesPerDirectory: 4,
});
export interface ReferencedFile {
  path: string;
  source_type: "PROJECT_FILE";
  content: string;
  truncated: boolean;
}
export interface FileContext {
  files: ReferencedFile[];
  directories: { path: string; entries: string[] }[];
  warnings: { path: string; code: FileReferenceErrorCode | "truncated" }[];
}

// Fixed selection, not a semantic relevance model; directories are never recursively crawled.
const KEY_FILES = [
  "README.md",
  "README",
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "src/index.ts",
  "src/main.ts",
  "index.ts",
  "main.py",
] as const;
function safeError(error: unknown): FileReferenceError {
  return error instanceof FileReferenceError ? error : new FileReferenceError("unavailable");
}
function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameFile(a: Stats, b: Stats): boolean {
  return (
    sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  );
}
async function projectRoot(input: string): Promise<string> {
  try {
    if (!isAbsolute(input) || !ApprovalPathSchema.safeParse(input).success) throw new Error();
    const root = await realpath(input);
    if (
      root === parse(root).root ||
      !ApprovalPathSchema.safeParse(root).success ||
      !(await lstat(root)).isDirectory()
    )
      throw new Error();
    return root;
  } catch {
    throw new FileReferenceError("invalid_root");
  }
}

/** Recheck every component below the canonical root; no symlink expansion below that root. */
async function inspect(root: string, path: string): Promise<{ absolute: string; info: Stats }> {
  if (blocked(path)) throw new FileReferenceError("blocked_path");
  let absolute = root;
  let info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new FileReferenceError("changed");
  for (const part of path === "." ? [] : path.split("/")) {
    absolute = join(absolute, part);
    info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new FileReferenceError("symlink");
  }
  const rest = relative(root, absolute);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest))
    throw new FileReferenceError("invalid_path");
  return { absolute, info };
}

async function readText(root: string, path: string): Promise<ReferencedFile> {
  const before = await inspect(root, path);
  if (!before.info.isFile()) throw new FileReferenceError("not_regular");
  const handle = await open(
    before.absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before.info, opened)) throw new FileReferenceError("changed");
    const buffer = Buffer.alloc(FILE_CONTEXT_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (
      !sameFile(opened, await handle.stat()) ||
      !sameFile(opened, (await inspect(root, path)).info)
    )
      throw new FileReferenceError("changed");
    const truncated = length > FILE_CONTEXT_LIMITS.fileBytes;
    let content: string;
    try {
      // Streaming decode drops an incomplete final code point only when deliberately truncated.
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, Math.min(length, FILE_CONTEXT_LIMITS.fileBytes)),
        { stream: truncated },
      );
    } catch {
      throw new FileReferenceError("binary");
    }
    if (
      Array.from(content).some((char) => {
        const code = char.codePointAt(0)!;
        return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
      })
    )
      throw new FileReferenceError("binary");
    return { path, source_type: "PROJECT_FILE", content, truncated };
  } finally {
    await handle.close();
  }
}

async function listDirectory(root: string, path: string): Promise<string[]> {
  const before = await inspect(root, path);
  if (!before.info.isDirectory()) throw new FileReferenceError("not_regular");
  const directory = await opendir(before.absolute);
  const entries: string[] = [];
  let count = 0;
  for await (const entry of directory) {
    if (++count > FILE_CONTEXT_LIMITS.directoryEntries)
      throw new FileReferenceError("too_many_entries");
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
    const child = posix.join(path, entry.name);
    if (blocked(child) || !ApprovalPathSchema.safeParse(child).success || child.includes("\\"))
      continue;
    entries.push(entry.name + (entry.isDirectory() ? "/" : ""));
  }
  if (!sameIdentity(before.info, (await inspect(root, path)).info))
    throw new FileReferenceError("changed");
  return entries.sort();
}

/** All explicit paths must succeed. No networking, persistence, model calls or ambient file reads. */
export async function loadFileContext(root: string, text: string): Promise<FileContext> {
  const paths = [...new Set(parseFileReferences(text).map((ref) => ref.path))];
  const result: FileContext = { files: [], directories: [], warnings: [] };
  if (!paths.length) return result;
  try {
    const canonical = await projectRoot(root);
    const directories: string[] = [];
    let bytes = 0;
    const add = async (path: string) => {
      if (result.files.some((file) => file.path === path)) return;
      if (result.files.length >= FILE_CONTEXT_LIMITS.files)
        throw new FileReferenceError("too_many_files");
      const file = await readText(canonical, path);
      const size = Buffer.byteLength(file.content, "utf8");
      if (bytes + size > FILE_CONTEXT_LIMITS.totalBytes)
        throw new FileReferenceError("budget_exceeded");
      bytes += size;
      result.files.push(file);
      if (file.truncated) result.warnings.push({ path, code: "truncated" });
    };
    // Explicit files take precedence over automatically selected key files, regardless of input order.
    for (const path of paths) {
      const { info } = await inspect(canonical, path);
      if (info.isDirectory()) directories.push(path);
      else await add(path);
    }
    for (const path of directories) {
      result.directories.push({ path, entries: await listDirectory(canonical, path) });
      let selected = 0;
      for (const key of KEY_FILES) {
        const child = posix.join(path, key);
        let info: Stats;
        try {
          info = (await inspect(canonical, child)).info;
        } catch (error) {
          // Missing conventional names are normal; don't fabricate evidence or noisy missing warnings.
          if (
            !(error instanceof FileReferenceError) &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
            continue;
          result.warnings.push({ path: child, code: safeError(error).code });
          continue;
        }
        if (!info.isFile()) continue;
        if (selected++ >= FILE_CONTEXT_LIMITS.keyFilesPerDirectory) break;
        try {
          await add(child);
        } catch (error) {
          result.warnings.push({ path: child, code: safeError(error).code });
        }
      }
    }
    return result;
  } catch (error) {
    throw safeError(error);
  }
}

/** Paths only; callers quote spaces. Invalid, unavailable or excessive listings offer no candidates. */
export async function completeReferencePath(root: string, prefix: string): Promise<string[]> {
  try {
    const path = prefix === "" ? "" : normalizeReferencePath(prefix);
    const trailing = prefix.endsWith("/");
    const parent = trailing ? path : posix.dirname(path || ".");
    const name = trailing || !prefix ? "" : posix.basename(path);
    const canonical = await projectRoot(root);
    return (await listDirectory(canonical, parent))
      .filter((entry) => entry.startsWith(name))
      .map((entry) => (parent === "." ? "" : parent + "/") + entry);
  } catch {
    return [];
  }
}

/** This encodes data boundaries; it cannot make model instructions in a file trustworthy. */
export function renderFileContext(context: FileContext): string {
  if (!context.files.length && !context.directories.length && !context.warnings.length) return "";
  const payload = JSON.stringify(context).replace(
    /[<>\u202a-\u202e\u2066-\u2069]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `<mnemic-file-context>\n${payload}\n</mnemic-file-context>`;
}
