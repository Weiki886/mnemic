import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErrorCode, problem } from "@mnemic/shared";
import { isPublicTransportRequest } from "./auth.js";

const BucketSettings = z
  .object({
    capacity: z.number().int().min(1).max(1_000_000),
    refillPerSecond: z.number().finite().min(0.001).max(1_000_000),
  })
  .strict();
const BucketStoreSettings = BucketSettings.extend({
  maxKeys: z.number().int().min(1).max(65_536),
}).strict();
const RequestSettings = z
  .object({
    ip: BucketSettings.default({ capacity: 120, refillPerSecond: 2 }),
    token: BucketSettings.default({ capacity: 240, refillPerSecond: 4 }),
    maxIps: z.number().int().min(1).max(65_536).default(4096),
  })
  .strict();
export type RequestRateLimitOptions = z.input<typeof RequestSettings>;

type Decision = { allowed: boolean; retryAfterSeconds: number };

/** Synchronous admission is atomic within one JS instance, not across processes. */
export function createTokenBucket(
  options: z.input<typeof BucketStoreSettings>,
  clock: () => number = () => performance.now(),
): { consume(key: string): Decision } {
  const { capacity, refillPerSecond, maxKeys } = BucketStoreSettings.parse(options);
  const fullRefillMs = (capacity * 1000) / refillPerSecond;
  // In insertion/touch order. A fully idle bucket can be forgotten without granting extra tokens.
  const buckets = new Map<string, { tokens: number; at: number }>();
  let lastNow = -Infinity;
  return {
    consume(key) {
      const now = Math.max(lastNow, clock());
      lastNow = now;
      let bucket = buckets.get(key);
      if (!bucket) {
        // Bound work as well as memory: never scan the entire table on an attacker's request.
        let scanned = 0;
        for (const [oldKey, old] of buckets) {
          if (scanned++ >= 64 || now - old.at < fullRefillMs) break;
          buckets.delete(oldKey);
        }
        if (buckets.size >= maxKeys) {
          return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(fullRefillMs / 1000)) };
        }
        bucket = { tokens: capacity, at: now };
      }
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + ((now - bucket.at) * refillPerSecond) / 1000,
      );
      bucket.at = now;
      const allowed = bucket.tokens >= 1;
      if (allowed) bucket.tokens -= 1;
      buckets.delete(key);
      buckets.set(key, bucket);
      return {
        allowed,
        retryAfterSeconds: allowed
          ? 0
          : Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond)),
      };
    },
  };
}

export function createRequestRateLimits(
  options: RequestRateLimitOptions | undefined,
  corsOrigin?: string,
) {
  const settings = RequestSettings.parse(options === undefined ? {} : options);
  const ips = createTokenBucket({ ...settings.ip, maxKeys: settings.maxIps });
  // #20 has exactly one valid global Bearer identity. No credential string is stored as a key.
  const token = createTokenBucket({ ...settings.token, maxKeys: 1 });
  function reject(request: FastifyRequest, reply: FastifyReply, decision: Decision) {
    if (corsOrigin && request.headers.origin === corsOrigin)
      reply
        .header("access-control-allow-origin", corsOrigin)
        .header("access-control-expose-headers", "retry-after, x-request-id")
        .header("vary", "Origin");
    return reply
      .code(429)
      .type("application/problem+json")
      .header("cache-control", "no-store")
      .header("retry-after", String(decision.retryAfterSeconds))
      .send(
        problem({
          status: 429,
          code: ErrorCode.RATE_LIMITED,
          detail: "请求过于频繁，请等待后重试",
          requestId: request.id,
        }),
      );
  }
  return {
    async ip(request: FastifyRequest, reply: FastifyReply) {
      if (isPublicTransportRequest(request, corsOrigin)) return;
      // Fastify trustProxy remains false: headers cannot choose a new limiter identity.
      const decision = ips.consume(request.ip);
      if (!decision.allowed) return reject(request, reply, decision);
    },
    async token(request: FastifyRequest, reply: FastifyReply) {
      if (isPublicTransportRequest(request, corsOrigin)) return;
      const decision = token.consume("authenticated");
      if (!decision.allowed) return reject(request, reply, decision);
    },
  };
}
