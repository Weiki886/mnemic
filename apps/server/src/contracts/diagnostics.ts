import { z } from "zod";
import { DoctorReportSchema } from "@mnemic/shared/doctor";

/** Existing strict empty object rules for doctor GET query and explicit probe body. */
export const DoctorInputSchema = z.object({}).strict();
export const RecallParamsSchema = z.object({ projectId: z.string().uuid() });
export const ReadDoctorReportSchema = DoctorReportSchema.extend({ probe: z.literal(false) });
export const ProbeDoctorReportSchema = DoctorReportSchema.extend({ probe: z.literal(true) });
