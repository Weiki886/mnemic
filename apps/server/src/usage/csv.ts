import type { UsageExportPage } from "@mnemic/shared/usage";
export function usageCsv(page: UsageExportPage): string {
  const columns = [
    "project_id",
    "currency",
    "pricing_revision",
    "id",
    "conversation_id",
    "provider_name",
    "model_id",
    "slot",
    "purpose",
    "status",
    "started_at",
    "duration_ms",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cached_input_tokens",
    "estimated_cost",
  ] as const;
  const cell = (value: string | null) => {
    let text = value ?? "";
    if (/^\s*[=+\-@]|^[\t\r\n]/u.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return (
    [
      columns.map(cell).join(","),
      ...page.records.map((r) => {
        const row = {
          ...r,
          project_id: page.project_id,
          currency: page.currency,
          pricing_revision: page.pricing_revision,
        };
        return columns.map((k) => cell(row[k])).join(",");
      }),
    ].join("\r\n") + "\r\n"
  );
}
