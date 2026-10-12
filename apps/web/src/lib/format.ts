const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

const STATUS_LABELS: Record<string, string> = {
  active: "生效中",
  deleted: "已删除",
  retracted: "已撤回",
};

const RELATION_LABELS: Record<string, string> = {
  equal: "一致",
  strengthen: "增强",
  weaken: "削弱",
  supersede: "取代",
  extend: "补充",
  ignore: "忽略",
  retract: "撤回",
  late_evidence: "迟到证据",
};

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function relationLabel(relation: string | null | undefined): string {
  if (!relation) return "—";
  return RELATION_LABELS[relation] ?? relation;
}
