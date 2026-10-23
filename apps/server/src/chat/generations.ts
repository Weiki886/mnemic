import type { FastifyReply, FastifyRequest } from "fastify";
import { ErrorCode, problem, zodIssues } from "@mnemic/shared";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

export interface Generation {
  id: string;
  projectId: string;
  conversationId: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

/** A0 single-server coordinator. Not a distributed lock or crash recovery journal. */
export class ChatGenerations {
  private locks = new Map<string, number>();
  private exclusive = new Set<string>();
  private active = new Map<string, Generation>();
  private closing = false;

  private acquire(ids: string[], exclusive = false) {
    const keys = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (
      this.closing ||
      keys.some((id) => this.exclusive.has(id) || (exclusive && this.locks.has(id)))
    )
      return;
    keys.forEach((id) => {
      this.locks.set(id, (this.locks.get(id) ?? 0) + 1);
      if (exclusive) this.exclusive.add(id);
    });
    return () =>
      keys.forEach((id) => {
        const count = this.locks.get(id)! - 1;
        if (count) this.locks.set(id, count);
        else this.locks.delete(id);
        if (exclusive) this.exclusive.delete(id);
      });
  }
  start(projectId: string, conversationId: string): Generation | undefined {
    if (this.atCapacity) return;
    const release = this.acquire([conversationId], true);
    if (!release) return;
    const id = uuidv7();
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const g: Generation = {
      id,
      projectId,
      conversationId,
      controller: new AbortController(),
      done,
      finish: () => {
        if (this.active.delete(id)) {
          release();
          resolve();
        }
      },
    };
    this.active.set(id, g);
    return g;
  }
  find(projectId: string, conversationId: string, generationId: string) {
    const g = this.active.get(generationId);
    return g?.projectId === projectId && g.conversationId === conversationId ? g : undefined;
  }
  get atCapacity() {
    return this.active.size >= 32;
  }
  guard(
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    currentId?: string,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = z
        .object({
          id: z.string().uuid().toLowerCase(),
          current_conversation_id: z.string().uuid().toLowerCase().optional(),
        })
        .safeParse({ ...(request.params as object), current_conversation_id: currentId });
      if (!parsed.success)
        return reply
          .code(400)
          .type("application/problem+json")
          .send(
            problem({
              status: 400,
              code: ErrorCode.VALIDATION_FAILED,
              detail: "会话路径参数非法",
              errors: zodIssues(parsed.error),
              requestId: request.id,
            }),
          );
      const { id, current_conversation_id: current } = parsed.data;
      const release = this.acquire([id, ...(typeof current === "string" ? [current] : [])]);
      if (!release) return generationConflict(reply, request.id);
      try {
        return await handler(request, reply);
      } finally {
        release();
      }
    };
  }
  async shutdown() {
    this.closing = true;
    const generations = [...this.active.values()];
    generations.forEach((g) => g.controller.abort());
    await Promise.all(generations.map((g) => g.done));
  }
}

export function generationConflict(reply: FastifyReply, requestId: string, reason?: "capacity") {
  return reply
    .code(409)
    .type("application/problem+json")
    .send(
      problem({
        status: 409,
        code: ErrorCode.CONFLICT,
        detail:
          reason === "capacity"
            ? "活动流式生成已达 32 个，请稍后重试"
            : "会话正在生成或服务正在停止，请先取消当前生成",
        requestId,
      }),
    );
}

/** Native abort race; always handles late rejection from an uncooperative provider/read. */
export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("generation interrupted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    task.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}
