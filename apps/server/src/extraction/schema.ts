import { z } from "zod";

/**
 * 候选 Observation 的提取 Schema（#4）。
 * 与 DB observations 表对齐，但此处是"提取候选"：evidence_id / project_id
 * 由写入链路后续补挂（#16），authority/reliability 由代码按映射表推导（非模型输出）。
 */
export const CandidateSchema = z.object({
  type: z.enum(["fact", "preference", "decision", "progress"]),
  subject: z.string().min(1),
  attribute: z.string().min(1),
  value: z.string().min(1),
  valid_time: z.string().describe("ISO 8601 或模糊时间原文"),
  time_precision: z.enum(["DAY", "WEEK", "MONTH", "FUZZY"]),
  time_confidence: z.number().min(0).max(1),
  assertion_intent: z.enum(["ASSERT", "UPDATE", "CORRECT", "RETRACT"]),
  source_type: z.enum([
    "USER_CORRECTION",
    "USER_EXPLICIT",
    "PROJECT_FILE",
    "TOOL_OBSERVATION",
    "DOCUMENT",
    "WEB_CONTENT",
    "AGENT_INFERENCE",
  ]),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  entities: z.array(z.string()),
  is_profile: z.boolean(),
});

export type Candidate = z.infer<typeof CandidateSchema>;
