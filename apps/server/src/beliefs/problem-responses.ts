import type { FastifyReply } from "fastify";
import type { ZodError } from "zod";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";

export function badRequest(
  reply: FastifyReply,
  requestId: string,
  detail: string,
  error: ZodError,
) {
  return reply
    .code(400)
    .header("content-type", "application/problem+json")
    .send(
      problem({
        status: 400,
        code: ErrorCode.VALIDATION_FAILED,
        detail,
        errors: zodIssues(error),
        requestId,
      }),
    );
}

export function notFound(reply: FastifyReply, requestId: string, id: string) {
  return reply
    .code(404)
    .header("content-type", "application/problem+json")
    .send(
      problem({
        status: 404,
        code: ErrorCode.NOT_FOUND,
        detail: `Belief 不存在：${id}`,
        requestId,
      }),
    );
}

export function conflict(reply: FastifyReply, requestId: string, detail: string) {
  return reply
    .code(409)
    .header("content-type", "application/problem+json")
    .send(problem({ status: 409, code: ErrorCode.CONFLICT, detail, requestId }));
}
