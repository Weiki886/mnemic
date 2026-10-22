import type { Key } from "ink";

export interface LineState {
  text: string;
  /** Unicode code-point offset, not UTF-16 offset. */
  cursor: number;
}

/** 同步行编辑：所有按键使用上一按键的结果，不依赖 React 完成一次渲染。 */
export function editLine(line: LineState, input: string, key: Partial<Key>): LineState {
  const chars = Array.from(line.text);
  const cursor = Math.max(0, Math.min(line.cursor, chars.length));
  if (
    key.ctrl ||
    key.meta ||
    key.escape ||
    key.tab ||
    key.return ||
    key.upArrow ||
    key.downArrow ||
    key.pageUp ||
    key.pageDown
  )
    return line;
  if (key.leftArrow) return { ...line, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { ...line, cursor: Math.min(chars.length, cursor + 1) };
  if (key.home) return { ...line, cursor: 0 };
  if (key.end) return { ...line, cursor: chars.length };
  // 延续旧输入框约定：Backspace/Delete 都删除光标前的字符。
  if (key.backspace || key.delete) {
    if (!cursor) return line;
    chars.splice(cursor - 1, 1);
    return { text: chars.join(""), cursor: cursor - 1 };
  }
  if (!input) return line;
  const pasted = Array.from(input);
  return {
    text: chars.slice(0, cursor).concat(pasted, chars.slice(cursor)).join(""),
    cursor: cursor + pasted.length,
  };
}
