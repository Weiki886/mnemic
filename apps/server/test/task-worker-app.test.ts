import { expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
it("starts an explicitly injected worker on ready and drains it before app close completes", async () => {
  let release!: () => void;
  const drained = new Promise<{ drained: boolean }>((r) => {
    release = () => r({ drained: true });
  });
  const worker = { start: vi.fn(), stop: vi.fn(() => drained) };
  const app = buildApp({ auth: false, taskWorker: worker, shutdownDrainMs: 1000 });
  try {
    await app.ready();
    expect(worker.start).toHaveBeenCalledOnce();
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledWith(1000));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  } finally {
    release();
    await app.close();
  }
});
it("reports a worker drain deadline with fixed text, without serializing exceptions", async () => {
  let logs = "";
  const app = buildApp({
    auth: false,
    taskWorker: {
      start() {},
      async stop() {
        return { drained: false };
      },
    },
    logStream: {
      write: (line) => {
        logs += line;
      },
    },
  });
  await app.ready();
  await app.close();
  expect(logs).toContain("task worker shutdown drain timeout");
});
it("shutdown adapter failures are logged with fixed text rather than raw exceptions", async () => {
  let logs = "";
  const app = buildApp({
    auth: false,
    taskWorker: {
      start() {},
      async stop() {
        throw Error("sk-privateclose01234567890123456789");
      },
    },
    logStream: {
      write: (s) => {
        logs += s;
      },
    },
  });
  await app.ready();
  await app.close();
  expect(logs).toContain("task worker shutdown failed");
  expect(logs).not.toContain("sk-privateclose");
});
it("rejects an incompatible managed-worker shutdown budget before starting anything", () => {
  const worker = { start: vi.fn(), stop: vi.fn(async () => ({ drained: true })) };
  for (const shutdownDrainMs of [60001, -1, NaN, Infinity, 1.5])
    expect(() => buildApp({ auth: false, taskWorker: worker, shutdownDrainMs })).toThrow(
      "managed worker shutdownDrainMs",
    );
  expect(worker.start).not.toHaveBeenCalled();
  expect(worker.stop).not.toHaveBeenCalled();
});
it("captures the managed worker and drain budget before caller options can change", async () => {
  const first = { start: vi.fn(), stop: vi.fn(async () => ({ drained: true })) };
  const replacement = { start: vi.fn(), stop: vi.fn(async () => ({ drained: true })) };
  const options = { auth: false, taskWorker: first, shutdownDrainMs: 1000 };
  const app = buildApp(options);
  try {
    await app.ready();
    options.taskWorker = replacement;
    options.shutdownDrainMs = 60001;
    await app.close();
    expect(first.stop).toHaveBeenCalledWith(1000);
    expect(replacement.stop).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
