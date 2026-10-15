import { z } from "zod";

export const DoctorCheckSchema = z.object({
  name: z.enum([
    "database",
    "configuration",
    "authentication",
    "embedding_dimensions",
    "chat",
    "extraction",
    "embedding",
  ]),
  status: z.enum(["ok", "error", "skipped"]),
  detail: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

/** ok 表示未检测到错误；skipped（未探测模型/未启用鉴权）不是验证成功。 */
export const DoctorReportSchema = z.object({
  ok: z.boolean(),
  probe: z.boolean(),
  configSource: z.literal("server"),
  checks: z.array(DoctorCheckSchema),
});

export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
