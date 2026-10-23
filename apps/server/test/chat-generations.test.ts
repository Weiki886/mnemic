import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChatGenerations, generationConflict } from "../src/chat/generations.js";

describe("chat generation admission boundaries", () => {
  it("does not cap independent legacy JSON requests at 32", async () => {
    const app = Fastify();
    const registry = new ChatGenerations();
    let release!: () => void,
      entered = 0;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    app.post(
      "/legacy/:id",
      registry.guard(async () => {
        entered++;
        await gate;
        return { ok: true };
      }),
    );
    const requests = Array.from({ length: 34 }, () =>
      app.inject({ method: "POST", url: `/legacy/${randomUUID()}` }),
    );
    const pending = Promise.all(requests.map((p) => p.then((r) => r.statusCode)));
    try {
      await vi.waitFor(() => expect(entered).toBe(34));
      // Legacy reservations do not consume stream quota either.
      const stream = registry.start(randomUUID(), randomUUID());
      expect(stream).toBeDefined();
      stream?.finish();
      release();
      expect(await pending).toEqual(Array(34).fill(200));
    } finally {
      release();
      await pending;
      await app.close();
    }
  });
  it("full stream capacity still allows unrelated legacy JSON but excludes the active conversation", async () => {
    const app = Fastify(),
      registry = new ChatGenerations();
    const active = Array.from({ length: 32 }, () => registry.start(randomUUID(), randomUUID())!);
    app.post(
      "/legacy/:id",
      registry.guard(async () => ({ ok: true })),
    );
    try {
      expect(registry.start(randomUUID(), randomUUID())).toBeUndefined();
      expect(
        (await app.inject({ method: "POST", url: `/legacy/${randomUUID()}` })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: `/legacy/${active[0]!.conversationId}` }))
          .statusCode,
      ).toBe(409);
    } finally {
      active.forEach((g) => g.finish());
      await app.close();
    }
  });
  it("rejects malformed path UUID before entering the handler", async () => {
    const app = Fastify(),
      registry = new ChatGenerations(),
      handler = vi.fn(async () => ({ ok: true }));
    app.post("/legacy/:id", registry.guard(handler));
    try {
      const r = await app.inject({ method: "POST", url: "/legacy/not-a-uuid" });
      expect(r.statusCode).toBe(400);
      expect(r.json().errors[0].path).toBe("id");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("does not interpret ignored JSON body fields as a current-conversation lock", async () => {
    const app = Fastify(),
      registry = new ChatGenerations();
    const active = registry.start(randomUUID(), randomUUID())!;
    app.post(
      "/legacy/:id",
      registry.guard(async () => ({ ok: true })),
    );
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/legacy/${randomUUID()}`,
            payload: { current_conversation_id: active.conversationId },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      active.finish();
      await app.close();
    }
  });
  it("validates explicitly supplied resume current UUID before entering a handler", async () => {
    const app = Fastify(),
      registry = new ChatGenerations(),
      handler = vi.fn(async () => ({ ok: true }));
    app.post("/resume/:id", registry.guard(handler, "invalid-current"));
    try {
      const r = await app.inject({ method: "POST", url: `/resume/${randomUUID()}` });
      expect(r.statusCode).toBe(400);
      expect(r.json().errors[0].path).toBe("current_conversation_id");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("reports full stream capacity distinctly from a busy conversation", async () => {
    const app = Fastify();
    app.post("/full", async (req, reply) => generationConflict(reply, req.id, "capacity"));
    try {
      const r = await app.inject({ method: "POST", url: "/full" });
      expect(r.statusCode).toBe(409);
      expect(r.json().detail).toContain("32");
    } finally {
      await app.close();
    }
  });
});
