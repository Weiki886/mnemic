import type { Candidate } from "./schema.js";

/**
 * 权威映射表（决策 4）：source_type → authority（排序值）/ reliability（0~1）。
 * 创建候选时即写入，随候选贯穿 Gate → Observation，不是 Resolver 前现算。
 * authority 步进 10 预留插入位；reliability 为提取评估初值，可被后续证据修正。
 */
export const AUTHORITY_TABLE = {
  USER_CORRECTION: { authority: 70, reliability: 0.98 },
  USER_EXPLICIT: { authority: 60, reliability: 0.95 },
  PROJECT_FILE: { authority: 50, reliability: 0.9 },
  TOOL_OBSERVATION: { authority: 40, reliability: 0.85 },
  DOCUMENT: { authority: 30, reliability: 0.7 },
  WEB_CONTENT: { authority: 20, reliability: 0.5 },
  AGENT_INFERENCE: { authority: 10, reliability: 0.4 },
} as const;

export type SourceType = keyof typeof AUTHORITY_TABLE;

export interface CandidateWithAuthority extends Candidate {
  authority: number;
  reliability: number;
}

export function attachAuthority(candidate: Candidate): CandidateWithAuthority {
  const entry = AUTHORITY_TABLE[candidate.source_type];
  return { ...candidate, authority: entry.authority, reliability: entry.reliability };
}
