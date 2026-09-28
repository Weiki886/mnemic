/**
 * 统一错误模型（RFC 7807 problem+json 风格）。
 * 服务端所有错误响应必须经 problem() 构造；code 为稳定机器可读错误码。
 *
 * 偏离标准字段表的两处显式决定：
 * 1. 不实现 instance——requestId 已覆盖其作用（标识本次异常的具体请求）。
 * 2. type 暂为 about:blank；#24 定 OpenAPI 契约时按错误码 URI 化，字面量联合预留形态。
 */

import type { ZodError } from "zod";

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** RFC 7807 type 字段：当前恒为 about:blank；#24 契约化时按错误码展开为 URI */
export type ProblemType = "about:blank" | `https://mnemic.dev/errors/${string}`;

/** 字段级校验错误（客户端可据此高亮/重试，不必解析 detail 字符串） */
export interface FieldError {
  path: string;
  message: string;
}

export interface ProblemDetails {
  type: ProblemType;
  title: string;
  status: number;
  detail?: string;
  code: ErrorCode;
  requestId?: string;
  errors?: FieldError[];
}

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
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
    type: "about:blank",
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
