import { Tokenizer } from "@huggingface/tokenizers";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(path: string, maxBytes: number) {
  // Nonblocking open lets us reject FIFOs and other non-regular files without hanging startup.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw Error();
    // Allow one extra byte to detect growth since fstat without an unbounded read.
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd, data, offset, data.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    if (offset !== stat.size) throw Error();
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, offset)),
    );
    if (!isJsonObject(json)) throw Error();
    return json;
  } finally {
    closeSync(fd);
  }
}

// Tokenizers.js can warn and skip an unknown pattern instead of rejecting it.
function validatePatterns(data: Record<string, unknown>) {
  const pending = [data.normalizer, data.pre_tokenizer, data.decoder];
  while (pending.length) {
    const component = pending.pop();
    if (!isJsonObject(component)) continue;
    if (component.type === "Replace" || component.type === "Split") {
      const pattern = component.pattern;
      if (
        !isJsonObject(pattern) ||
        Object.keys(pattern).length !== 1 ||
        (typeof pattern.Regex !== "string" && typeof pattern.String !== "string")
      )
        throw Error();
    }
    if (component.type === "Sequence") {
      for (const key of ["normalizers", "pretokenizers", "decoders"]) {
        const children = component[key];
        if (Array.isArray(children)) for (const child of children) pending.push(child);
      }
    }
  }
}

/** Loads trusted local assets once. The budget covers the memory block without sequence framing. */
export function loadLocalTokenizer(tokenizerFile: string, tokenizerConfigFile: string) {
  const data = readJsonObject(tokenizerFile, 32 * 1024 * 1024);
  validatePatterns(data);
  const tokenizer = new Tokenizer(data, readJsonObject(tokenizerConfigFile, 1024 * 1024));
  return (text: string): number => tokenizer.tokenize(text, { add_special_tokens: false }).length;
}
