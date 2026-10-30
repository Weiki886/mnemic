import { describe, expect, it } from "vitest";
import { createTokenBucket } from "../src/rate-limit.js";

describe("bounded token buckets", () => {
  it("permits only the initial burst and refills fractional tokens without rounding up", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 0.5, maxKeys: 2 }, () => now);
    expect(bucket.consume("a").allowed).toBe(true);
    expect(bucket.consume("a").allowed).toBe(true);
    expect(bucket.consume("a")).toEqual({ allowed: false, retryAfterSeconds: 2 });
    now = 1999;
    expect(bucket.consume("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now = 2000;
    expect(bucket.consume("a").allowed).toBe(true);
    now = 100000;
    expect([
      bucket.consume("a").allowed,
      bucket.consume("a").allowed,
      bucket.consume("a").allowed,
    ]).toEqual([true, true, false]);
  });

  it("does not evict active identities to issue new bursts; full idle buckets can be reclaimed", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, maxKeys: 2 }, () => now);
    expect(bucket.consume("a").allowed).toBe(true);
    expect(bucket.consume("b").allowed).toBe(true);
    expect(bucket.consume("c")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(bucket.consume("a").allowed).toBe(false);
    now = 1000;
    expect(bucket.consume("c").allowed).toBe(true);
    expect(bucket.consume("c").allowed).toBe(false);
    expect(bucket.consume("a").allowed).toBe(true);
  });

  it("never grants tokens on clock rollback", () => {
    let now = 5000;
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, maxKeys: 1 }, () => now);
    expect(bucket.consume("a").allowed).toBe(true);
    now = 0;
    expect(bucket.consume("a").allowed).toBe(false);
    now = 5000;
    expect(bucket.consume("a").allowed).toBe(false);
    now = 6000;
    expect(bucket.consume("a").allowed).toBe(true);
  });

  it.each([
    { capacity: 0 },
    { capacity: 1.5 },
    { capacity: 1000001 },
    { refillPerSecond: 0 },
    { refillPerSecond: NaN },
    { refillPerSecond: Infinity },
    { maxKeys: 0 },
    { maxKeys: 1.5 },
    { maxKeys: 65537 },
    { unknown: true },
  ])("rejects invalid settings before allocation (%#)", (change) => {
    expect(() =>
      createTokenBucket({ capacity: 2, refillPerSecond: 1, maxKeys: 2, ...change }),
    ).toThrow();
  });
});
