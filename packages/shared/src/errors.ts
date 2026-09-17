/**
 * 统一错误模型（RFC 7807 problem+json 风格）。
 * 服务端所有错误响应必须经 problem() 构造；code 为稳定机器可读错误码。
 */

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: ErrorCode;
  requestId?: string;
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
}): ProblemDetails {
  const body: ProblemDetails = {
    type: "about:blank",
    title: input.title ?? STATUS_TITLES[input.status] ?? "Error",
    status: input.status,
    code: input.code,
  };
  if (input.detail !== undefined) body.detail = input.detail;
  if (input.requestId !== undefined) body.requestId = input.requestId;
  return body;
}
