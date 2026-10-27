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
