import { z } from "zod";
/** Explicit whole-instance operation: never silently interpret a project filter as authorization. */
export const MemoryExportRequestSchema = z.object({ scope: z.literal("instance") }).strict();
export const MemoryExportQuerySchema = z.object({}).strict();
