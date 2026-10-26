import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  DEBUG_MAX_LINE_BYTES,
  DebugSelectionSchema,
  parseDebugLine,
  type DebugSelection,
} from "@mnemic/shared/debug";

export const DEBUG_HELP = `mnemic debug --file PATH --project UUID [--conversation UUID] [--target UUID] [--content] [--limit N] [--json]
读取本地服务端 JSONL 快照；不连接服务、不启用服务端捕获、不调用模型。
默认仅元数据；--content 才展示已有的敏感正文。项目筛选不是鉴权，文件访问权由操作系统控制。
默认 limit=50，上限1000；限制条数会明确提示，不截断单条正文。活动日志请先复制为快照。
`;
const MAX_FILE = 64 * 1024 * 1024,
  MAX_OUTPUT = 8 * 1024 * 1024;
// JSON.stringify already escapes C0. Escape remaining terminal controls and directional overrides too.
const safeJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Explicit operator file, no implicit search/stdin/follow/network. Buffer only bounded selected records. */
export async function readDebugLog(file: string, selection: DebugSelection) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE) throw Error("unavailable");
    const records: object[] = [];
    let matched = 0,
      ignored = 0,
      position = 0,
      lineBytes = 0,
      outputBytes = 0;
    let pending: Buffer[] = [];
    const line = () => {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(pending, lineBytes),
        );
        const record = parseDebugLine(text);
        if (!record) {
          ignored++;
          return;
        }
        if (
          record.detail.project_id !== selection.project_id ||
          (selection.conversation_id &&
            (!("conversation_id" in record.detail) ||
              record.detail.conversation_id !== selection.conversation_id)) ||
          (selection.target_id && record.target_id !== selection.target_id)
        )
          return;
        matched++;
        if (records.length >= selection.limit) return;
        let selected: object = record;
        if (!selection.include_content && "content" in record.detail) {
          const { content: _content, ...detail } = record.detail;
          selected = { ...record, detail };
        }
        outputBytes += Buffer.byteLength(safeJson(selected));
        if (outputBytes > MAX_OUTPUT) throw Error("output_limit");
        records.push(selected);
      } catch (error) {
        if (error instanceof TypeError) {
          ignored++;
          return;
        } // Malformed UTF-8: no raw decoder message.
        throw error;
      } finally {
        pending = [];
        lineBytes = 0;
      }
    };
    while (position < before.size) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, before.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) throw Error("changed");
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const found = buffer.indexOf(10, start),
          end = found < 0 || found >= bytesRead ? bytesRead : found;
        lineBytes += end - start;
        if (lineBytes > DEBUG_MAX_LINE_BYTES) throw Error("line_limit");
        pending.push(buffer.subarray(start, end));
        if (end < bytesRead) line();
        start = end + 1;
      }
    }
    if (lineBytes) line();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("changed");
    return { records, matched, shown: records.length, ignored, limited: matched > records.length };
  } finally {
    await handle.close();
  }
}

export async function runDebugCommand(
  args: string[],
  write: (text: string) => void,
): Promise<number> {
  let file: string, selection: DebugSelection, json: boolean;
  try {
    const parsed = parseArgs({
      args,
      tokens: true,
      options: {
        file: { type: "string" },
        project: { type: "string" },
        conversation: { type: "string" },
        target: { type: "string" },
        content: { type: "boolean" },
        json: { type: "boolean" },
        limit: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option" || seen.has(token.name)) throw Error("arguments");
      seen.add(token.name);
    }
    if (parsed.values.help) {
      write(DEBUG_HELP);
      return 0;
    }
    file = parsed.values.file ?? "";
    if (!file || file.includes("\0") || file.length > 4096) throw Error("file");
    if (parsed.values.limit !== undefined && !/^\d+$/.test(parsed.values.limit))
      throw Error("limit");
    selection = DebugSelectionSchema.parse({
      project_id: parsed.values.project,
      ...(parsed.values.conversation ? { conversation_id: parsed.values.conversation } : {}),
      ...(parsed.values.target ? { target_id: parsed.values.target } : {}),
      include_content: parsed.values.content ?? false,
      limit: parsed.values.limit ?? 50,
    });
    json = parsed.values.json ?? false;
  } catch {
    write("调试查看参数无效。\n" + DEBUG_HELP);
    return 2;
  }
  try {
    const result = await readDebugLog(file, selection);
    const output = json
      ? safeJson(result)
      : [
          `匹配 ${result.matched} 条，展示 ${result.shown} 条，忽略 ${result.ignored} 条不兼容/非轨迹行${result.limited ? "；已限制条数，请缩小筛选或增加 --limit" : ""}。`,
          ...result.records.map((r) => safeJson(r)),
        ].join("\n");
    write(output + "\n");
    return 0;
  } catch {
    write("调试日志不可读取、已变化或超过资源上限；请使用较小的常规文件快照并缩小筛选。\n");
    return 1;
  }
}
