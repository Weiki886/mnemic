/**
 * 值比较（A0 启发式，无 NLI 模型——#5 非目标）：
 * 规范化后深度相等 → equal；新值包含旧值（字符串包含/对象超集/数组超集）→ extend；
 * 其余 → conflict。旧值包含新值视为 equal（没带来新信息，归强化）。
 */

export type ValueRelation = "equal" | "extend" | "conflict";

export function normalizeValue(v: unknown): unknown {
  if (typeof v === "string") return v.trim().toLowerCase();
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => [k.trim().toLowerCase(), normalizeValue(val)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** a 是否包含 b（字符串包含 / 对象浅层超集 / 数组超集），输入需已规范化 */
function contains(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.includes(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return b.every((item) => a.some((x) => deepEqual(x, item)));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object"
    && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    return Object.entries(bo).every(([k, bv]) => k in ao && deepEqual(ao[k], bv));
  }
  return false;
}

export function classifyValues(current: unknown, incoming: unknown): ValueRelation {
  const c = normalizeValue(current);
  const i = normalizeValue(incoming);
  if (deepEqual(c, i)) return "equal";
  if (contains(i, c)) return "extend";
  if (contains(c, i)) return "equal"; // 旧值已涵盖新值，没带来新信息
  return "conflict";
}
