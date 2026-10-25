import { ChatMessageInputSchema, type ProjectAttachment } from "@mnemic/shared/file-context";
import { completeReferencePath, loadFileContext, type FileContext } from "./file-context.js";
import { FileReferenceError, parseFileReferences } from "./file-references.js";
import type { LineState } from "./line-input.js";

/** Cancellation stops dispatch promptly; an already-issued read-only syscall may still finish locally. */
function readContext(root: string, text: string, signal?: AbortSignal): Promise<FileContext> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new FileReferenceError("cancelled"));
    if (signal?.aborted) {
      cancelled();
      return;
    }
    signal?.addEventListener("abort", cancelled, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", cancelled);
    loadFileContext(root, text).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
export async function prepareFileMessage(
  root: string | undefined,
  text: string,
  signal?: AbortSignal,
): Promise<{
  attachments: ProjectAttachment[];
  notice: string;
}> {
  if (signal?.aborted) throw new FileReferenceError("cancelled");
  if (!parseFileReferences(text).length) return { attachments: [], notice: "" };
  if (!root) throw new FileReferenceError("invalid_root");
  const context = await readContext(root, text, signal);
  if (signal?.aborted) throw new FileReferenceError("cancelled");
  const attachments: ProjectAttachment[] = [
    ...context.files.map((file) => ({
      kind: "file" as const,
      path: file.path,
      content: file.content,
      truncated: file.truncated,
    })),
    ...context.directories.map((dir) => ({
      kind: "directory" as const,
      path: dir.path,
      content: JSON.stringify(dir.entries),
      truncated: false,
    })),
  ];
  const parsed = ChatMessageInputSchema.safeParse({ text, attachments });
  if (!parsed.success) throw new FileReferenceError("invalid_context");
  const lines = [
    `引用文件 ${context.files.length} 个、目录 ${context.directories.length} 个；随本次消息发送到服务端。`,
    ...attachments.map(
      (file) =>
        `${file.kind === "directory" ? "目录" : "文件"} ${JSON.stringify(file.path)}${file.truncated ? "（已截断）" : ""}`,
    ),
    ...context.warnings.map(
      (warning) =>
        `${warning.code === "truncated" ? "截断" : "未附带"} ${JSON.stringify(warning.path)}：${warning.code}`,
    ),
  ];
  return { attachments: parsed.data.attachments!, notice: lines.join("\n") };
}

function activeReference(
  text: string,
  cursor: number,
): { start: number; end: number; prefix: string } | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && !/\s/u.test(text[i - 1]!)) || text[i + 1] === "@") continue;
    const start = i;
    const quoted = text[i + 1] === '"';
    const contentStart = i + (quoted ? 2 : 1);
    let end = contentStart;
    if (quoted) {
      const close = text.indexOf('"', contentStart);
      end = close < 0 ? text.length : close + 1;
    } else while (end < text.length && !/\s/u.test(text[end]!)) end++;
    const contentEnd = quoted && text[end - 1] === '"' ? end - 1 : end;
    if (cursor >= contentStart && cursor <= end)
      return { start, end, prefix: text.slice(contentStart, Math.min(cursor, contentEnd)) };
    i = end - 1;
  }
  return null;
}
function referenceText(path: string): string {
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}
/** Only explicit Tab invokes filesystem enumeration; cursor offsets remain Unicode code points. */
export async function completeFileInput(
  root: string,
  line: LineState,
): Promise<{ line: LineState; candidates: string[] }> {
  if (line.text.trimStart().startsWith("/")) return { line, candidates: [] };
  const cursor = Array.from(line.text).slice(0, line.cursor).join("").length;
  const active = activeReference(line.text, cursor);
  if (!active) return { line, candidates: [] };
  const paths = (await completeReferencePath(root, active.prefix)).filter(
    (path) => !path.includes('"'),
  );
  if (paths.length !== 1) return { line, candidates: paths.map(referenceText) };
  const path = paths[0]!,
    replacement = referenceText(path);
  const before = line.text.slice(0, active.start);
  const inside =
    path.endsWith("/") && replacement.endsWith('"') ? replacement.slice(0, -1) : replacement;
  return {
    line: {
      text: before + replacement + line.text.slice(active.end),
      cursor: Array.from(before + inside).length,
    },
    candidates: [],
  };
}
