import { expect, it, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { writePlatformAudit } from "../src/audit/events.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
it("new platform writers reject plaintext/unknown fields before touching storage", async () => {
  const insert = vi.fn();
  const db = { insert } as unknown as PostgresJsDatabase;
  await expect(
    writePlatformAudit(db, {
      actor: "server",
      action: "provider.create",
      target: uuidv7(),
      decision: "created",
      meta: { version: 1, protocol: "openai-compatible", slots: ["chat"], api_key: "sk-private" },
    }),
  ).rejects.toThrow();
  expect(insert).not.toHaveBeenCalled();
});
it("audit input is cloned before the first asynchronous storage wait", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let saved: unknown;
  const db = {
    insert: () => ({
      values: async (v: unknown) => {
        await wait;
        saved = v;
      },
    }),
  } as unknown as PostgresJsDatabase;
  const event = {
    actor: "server",
    action: "provider.create",
    target: uuidv7(),
    decision: "created",
    meta: { version: 1, protocol: "openai-compatible", slots: ["chat"] },
  };
  const pending = writePlatformAudit(db, event);
  event.meta.slots.push("private-data");
  release();
  await pending;
  expect(saved).toMatchObject({ meta: { slots: ["chat"] } });
  expect(JSON.stringify(saved)).not.toContain("private-data");
});
