import { z } from "zod";
/** Existing route scope rule; event and pagination contracts live in shared/approval-audit. */
export const ApprovalParamsSchema = z
  .object({ projectId: z.string().uuid().toLowerCase() })
  .strict();
