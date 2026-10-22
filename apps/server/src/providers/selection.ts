import type { ModelSlots } from "./repository.js";
/** 输入按 createdAt/id 升序；快照与真实槽位解析共享同一选择规则。 */
export function selectSlotProvider<T extends { models: unknown }>(
  rows: T[],
  slot: keyof ModelSlots,
): T | undefined {
  return rows.find((row) => (row.models as ModelSlots)[slot] !== undefined);
}
