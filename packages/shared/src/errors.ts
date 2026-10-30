/**
 * 统一错误模型（RFC 7807 problem+json 风格）。
 * 服务端所有错误响应必须经 problem() 构造；code 为稳定机器可读错误码。
 *
 * 偏离标准字段表的两处显式决定：
 * 1. 不实现 instance——requestId 已覆盖其作用（标识本次异常的具体请求）。
 * 2. type 使用稳定错误码 URI；about:blank 仅为旧服务端解析兼容保留，不承诺 URI 可在线解引用。
 */

import { z, type ZodError } from "zod";

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  MODEL_QUOTA_EXCEEDED: "MODEL_QUOTA_EXCEEDED",
  MODEL_QUOTA_UNAVAILABLE: "MODEL_QUOTA_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Stable identifiers, not Provider URLs or links fetched while handling an error. */
export const PROBLEM_TYPES = Object.freeze({
  VALIDATION_FAILED: "https://mnemic.dev/errors/validation-failed",
  UNAUTHORIZED: "https://mnemic.dev/errors/unauthorized",
  FORBIDDEN: "https://mnemic.dev/errors/forbidden",
  NOT_FOUND: "https://mnemic.dev/errors/not-found",
  CONFLICT: "https://mnemic.dev/errors/conflict",
  RATE_LIMITED: "https://mnemic.dev/errors/rate-limited",
  MODEL_QUOTA_EXCEEDED: "https://mnemic.dev/errors/model-quota-exceeded",
  MODEL_QUOTA_UNAVAILABLE: "https://mnemic.dev/errors/model-quota-unavailable",
  INTERNAL_ERROR: "https://mnemic.dev/errors/internal-error",
} as const satisfies Record<ErrorCode, `https://mnemic.dev/errors/${string}`>);
export const ErrorCodeSchema = z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]);
export const ProblemTypeSchema = z.enum(["about:blank", ...Object.values(PROBLEM_TYPES)]);
export type ProblemType = z.infer<typeof ProblemTypeSchema>;
export const FieldErrorSchema = z.object({ path: z.string(), message: z.string() }).strict();
export type FieldError = z.infer<typeof FieldErrorSchema>;
const ProblemBaseSchema = z
  .object({
    type: ProblemTypeSchema,
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    code: ErrorCodeSchema,
    requestId: z.string().optional(),
    errors: z.array(FieldErrorSchema).optional(),
  })
  .strict();
export type ProblemDetails = z.infer<typeof ProblemBaseSchema>;
// Keep code/URI pairing machine-checkable in both Zod and generated OpenAPI oneOf variants.
const variants = Object.values(ErrorCode).map((code) =>
  ProblemBaseSchema.extend({
    code: z.literal(code),
    type: z.union([z.literal("about:blank"), z.literal(PROBLEM_TYPES[code])]),
  }),
);
export const ProblemDetailsSchema: z.ZodType<ProblemDetails> = z.discriminatedUnion(
  "code",
  variants as [(typeof variants)[number], ...(typeof variants)[number][]],
);

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export function problem(input: {
  status: number;
  code: ErrorCode;
  detail?: string;
  requestId?: string;
  title?: string;
  errors?: FieldError[];
}): ProblemDetails {
  const body: ProblemDetails = {
    type: PROBLEM_TYPES[input.code],
    title: input.title ?? STATUS_TITLES[input.status] ?? "Error",
    status: input.status,
    code: input.code,
  };
  if (input.detail !== undefined) body.detail = input.detail;
  if (input.requestId !== undefined) body.requestId = input.requestId;
  if (input.errors !== undefined) body.errors = input.errors;
  return body;
}

/** ZodError → 字段级错误数组（嵌套路径点连接），供 400 响应填充 errors 扩展字段 */
export function zodIssues(error: ZodError): FieldError[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
