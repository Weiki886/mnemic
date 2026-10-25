import { posix } from "node:path";
import { ApprovalPathSchema } from "@mnemic/shared/approval";

export const MAX_FILE_REFERENCES = 8;
export interface FileReference {
  path: string;
  /** UTF-16 offsets for String.slice; not terminal code-point cursor positions. */
  start: number;
  end: number;
}
export type FileReferenceErrorCode =
  | "input_too_large"
  | "too_many_references"
  | "invalid_reference"
  | "invalid_path"
  | "invalid_root"
  | "blocked_path"
  | "symlink"
  | "unavailable"
  | "not_regular"
  | "changed"
  | "binary"
  | "too_many_entries"
  | "too_many_files"
  | "budget_exceeded";

/** Only stable local codes; raw filesystem errors/absolute paths are never exposed. */
export class FileReferenceError extends Error {
  constructor(readonly code: FileReferenceErrorCode) {
    super(code);
  }
}

export function normalizeReferencePath(path: string): string {
  if (
    !ApprovalPathSchema.safeParse(path).success ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[a-z]:/i.test(path)
  )
    throw new FileReferenceError("invalid_path");
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../"))
    throw new FileReferenceError("invalid_path");
  return normalized === "./" ? "." : normalized.replace(/\/$/, "");
}

/** Explicit whitespace-delimited references only; no shell/glob/interpolation evaluation. */
export function parseFileReferences(text: string): FileReference[] {
  if (typeof text !== "string" || text.length > 8000)
    throw new FileReferenceError("input_too_large");
  const refs: FileReference[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && !/\s/u.test(text[i - 1]!))) continue;
    const next = text[i + 1];
    if (!next || /\s/u.test(next) || next === "@") continue;
    const start = i;
    let path: string;
    if (next === '"') {
      const end = text.indexOf('"', i + 2);
      if (end < 0 || (text[end + 1] && !/[\s，。；：！？,;:!?)]/u.test(text[end + 1]!)))
        throw new FileReferenceError("invalid_reference");
      path = text.slice(i + 2, end);
      if (!path) throw new FileReferenceError("invalid_reference");
      i = end;
    } else {
      let end = i + 1;
      while (end < text.length && !/\s/u.test(text[end]!)) end++;
      path = text.slice(i + 1, end);
      i = end - 1;
    }
    refs.push({ path: normalizeReferencePath(path), start, end: i + 1 });
    if (refs.length > MAX_FILE_REFERENCES) throw new FileReferenceError("too_many_references");
  }
  return refs;
}
