import { z } from "zod";
/** Existing project parameter rules; query and output contracts live in shared/usage. */
export const UsageParamsSchema = z.object({ projectId: z.string().uuid().toLowerCase() }).strict();
