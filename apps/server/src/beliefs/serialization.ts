/** HTTP 评分契约：Drizzle numeric 字符串 → JSON number，保留 SQL NULL。 */
export function toApiNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}
